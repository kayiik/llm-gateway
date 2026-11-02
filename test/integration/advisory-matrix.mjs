import assert from 'node:assert/strict';
import { ensureOwnerFixture, ownerRequest } from '../qualification/owner-fixture.mjs';

export async function runAdvisoryMatrix({ admin, publicCall, metrics, save, registerSecret }) {
  const origin = process.env.REPLAY_ORIGIN, ssoSecret = process.env.REPLAY_SSO_SECRET;
  const owners = await ensureOwnerFixture({ origin, adminKey: process.env.REPLAY_ADMIN_KEY, ssoSecret });
  for (const secret of ['fixture-extension-secret', 'fixture-extension-owner-token', 'fixture-extension-refresh', owners.keys.a.token, owners.keys.b.token]) registerSecret(secret);
  const evidence = { boundary: 'Installed owner advisory allowance is scoped, revision/freshness-fenced and never an inference admission cap', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; evidence.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('advisory-matrix.json', evidence); } };
  const user = (actor, path, body) => ownerRequest({ origin, ssoSecret, actor, path: '/user/api/' + path, body, registerSecret });
  const ok = response => { assert.equal(response.status, 200, response.text); return response.json; };
  const select = (response, provider = 'quota-advisory') => {
    const value = ok(response); const item = value.quota_advisories?.find(row => row.provider_id === provider);
    assert.ok(item, 'the configured provider needs an explicit advisory, even when unknown'); return item;
  };
  const usage = async actor => select(await user(actor, 'usage'));
  const mode = async value => {
    const response = await fetch('http://127.0.0.1:18889/quota-daemon/control/allowance', { method: 'POST', body: JSON.stringify({ mode: value }), signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200); await response.json();
  };
  const signIn = async actor => {
    const name = 'quota-' + actor; const start = ok(await user(actor, 'connections/quota-advisory/oauth/start', { flow: 'device_code', connection_name: name })); registerSecret(start.device_code);
    let response;
    for (let attempt = 0; attempt < 5; attempt++) {
      response = ok(await user(actor, 'connections/quota-advisory/oauth/poll', { device_code: start.device_code, connection_name: name }));
      if (response.status === 'authorized') break;
    }
    assert.equal(response.status, 'authorized', JSON.stringify(response));
    const connections = ok(await user(actor, 'connections')).connections;
    const connection = connections.find(item => item.provider_id === 'quota-advisory' && item.connection_name === name); assert.ok(connection); return connection;
  };
  const refresh = async (actor, connection) => ok(await user(actor, 'connections/' + connection.id + '/quota/refresh', {}));
  const daemon = await admin('extensions', { id: 'qualification-quota-daemon', name: 'Qualification advisory daemon', url: 'http://upstream:18889/quota-daemon', secret: 'fixture-extension-secret' });
  await admin('providers', { id: 'quota-advisory', type: 'google_antigravity', extension: daemon.id });
  let a, b;
  await test('unobserved-and-foreign-allowance-is-unknown-without-invented-numbers', async row => {
    for (const actor of ['a', 'b']) {
      const advisory = await usage(actor); assert.equal(advisory.status, 'unknown'); assert.equal(advisory.source, 'no_verified_quota_adapter');
      for (const field of ['remaining', 'used', 'limit', 'dimensions']) assert.equal(advisory[field], undefined);
    }
    assert.equal((await metrics()).extensionQuota?.allowanceReads ?? 0, 0); row.inferredNumbers = 0;
  });
  await test('private-owner-device-flows-save-two-distinct-advisory-connections', async row => {
    a = await signIn('a'); b = await signIn('b'); assert.notEqual(a.id, b.id);
    for (const actor of ['a', 'b']) await admin('providers/quota-advisory/refresh?principal_id=' + owners.actors[actor].id, {});
    row.ownerConnections = 2;
  });
  await test('zero-is-an-observed-unverified-value-not-a-public-or-foreign-quota', async row => {
    await mode('fraction'); assert.equal((await refresh('a', a)).status, 'observed');
    await mode('zero'); assert.equal((await refresh('b', b)).status, 'observed');
    const mine = await usage('a'), theirs = await usage('b');
    assert.equal(mine.status, 'unknown'); assert.equal(theirs.status, 'unknown', 'best-effort allowance is never a verified Gateway limit');
    assert.deepEqual(mine.dimensions.map(d => d.connection_id), [a.id]); assert.deepEqual(theirs.dimensions.map(d => d.connection_id), [b.id]);
    assert.equal(mine.dimensions[0].remaining, 0.5); assert.equal(theirs.dimensions[0].remaining, 0);
    assert.equal(theirs.dimensions[0].unverified, true); assert.equal(mine.dimensions[0].unverified, true);
    const adminView = select({ status: 200, json: await admin('usage'), text: '' }); assert.equal(adminView.account_count, 2);
    assert.deepEqual(new Set(adminView.dimensions.map(d => d.connection_id)), new Set([a.id, b.id])); row.ownerRemaining = [0.5, 0];
  });
  await test('foreign-refresh-cannot-read-or-consume-another-owners-snapshot', async row => {
    const before = (await metrics()).extensionQuota.allowanceReads;
    const denied = await user('b', 'connections/' + a.id + '/quota/refresh', {}); assert.equal(denied.status, 404, denied.text);
    assert.equal((await metrics()).extensionQuota.allowanceReads, before); assert.deepEqual((await usage('b')).dimensions.map(d => d.connection_id), [b.id]); row.private = true;
  });
  await test('zero-allowance-is-advisory-and-does-not-block-selected-inference', async row => {
    const before = (await metrics()).extensionQuota.calls.length;
    const response = await publicCall('zero-advisory-still-dispatches', '/v1/chat/completions', { model: 'quota-advisory/quota-chat', messages: [{ role: 'user', content: 'extension text' }], stream: false }, owners.keys.b.token);
    assert.equal(response.status, 200, response.text); assert.equal((await metrics()).extensionQuota.calls.length, before + 1);
    assert.equal((await metrics()).extensionQuota.calls.at(-1).credential, 'owner'); row.advisoryDispatches = 1;
  });
  await test('unknown-refresh-does-not-replace-a-previous-observation', async row => {
    const old = await usage('a'); await mode('unknown'); assert.equal((await refresh('a', a)).status, 'unknown');
    const kept = await usage('a'); assert.deepEqual(kept.dimensions, old.dimensions); row.retainedAge = kept.refreshed_at;
  });
  await test('short-lived-observation-becomes-stale-without-a-new-provider-call', async row => {
    await mode('short'); assert.equal((await refresh('a', a)).status, 'observed');
    const fresh = await usage('a'); assert.equal(fresh.dimensions[0].remaining, 0.5);
    const count = (await metrics()).extensionQuota.allowanceReads; let stale;
    for (let attempt = 0; attempt < 20; attempt++) {
      stale = await usage('a'); if (stale.status === 'stale') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(stale.status, 'stale'); assert.equal(stale.source, 'stale_quota_snapshot'); assert.equal(stale.dimensions, undefined);
    assert.equal((await metrics()).extensionQuota.allowanceReads, count); row.staleWithoutRefresh = true;
  });
  await test('credential-rotation-fences-the-old-observation', async row => {
    await mode('fraction'); assert.equal((await refresh('a', a)).status, 'observed');
    const before = (await usage('a')).dimensions; assert.equal(before[0].connection_id, a.id);
    const rotated = await signIn('a'); assert.equal(rotated.id, a.id, 'same named connection must retain identity');
    const after = await usage('a'); assert.equal(after.status, 'unknown'); assert.equal(after.dimensions, undefined); row.revokedOldRevision = true;
  });
  evidence.pass = evidence.cases.length === 8 && evidence.cases.every(row => row.pass);
  save('advisory-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
