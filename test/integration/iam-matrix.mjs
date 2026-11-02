import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ensureOwnerFixture, ownerActors, ownerRequest } from '../qualification/owner-fixture.mjs';

export async function runIAMMatrix({ admin, request, publicCall, metrics, save, registerSecret }) {
  const origin = process.env.REPLAY_ORIGIN, adminKey = process.env.REPLAY_ADMIN_KEY, ssoSecret = process.env.REPLAY_SSO_SECRET;
  const seed = await ensureOwnerFixture({ origin, adminKey, ssoSecret });
  for (const value of Object.values(seed.keys)) registerSecret(value.token);
  for (const value of ['fixture-iam-system', 'fixture-iam-system-rotated', 'fixture-iam-a-one', 'fixture-iam-a-two', 'fixture-iam-a-two-rotated', 'fixture-iam-b']) registerSecret(value);
  const evidence = { boundary: 'Installed trusted proxy assertions, owner/admin/key boundaries, encrypted credentials and live identity lifecycle', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; evidence.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('iam-matrix.json', evidence); } };
  const user = (actor, path, body, options = {}) => ownerRequest({ origin, ssoSecret, actor, path: path.startsWith('/') ? path : '/user/api/' + path, body, registerSecret, ...options });
  const ok = response => { assert.ok(response.status >= 200 && response.status < 300, response.status + ': ' + response.text); return response.json; };
  const calls = async () => (await metrics()).iam?.calls ?? [];
  const infer = async (name, token, credential, model = 'iam-chat/fixture') => {
    const before = (await calls()).length;
    const response = await publicCall('iam-' + name, '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'identity' }], max_tokens: 17, temperature: 0.125 }, token);
    assert.equal(response.status, 200, response.text); assert.equal(JSON.parse(response.text).choices[0].message.content, 'credential:' + credential);
    assert.equal((await calls()).length, before + 1); return response;
  };
  const refuseKey = async (name, token, status = 401) => { const before = (await metrics()).inference; const response = await request('/v1/chat/completions', { model: 'iam-chat/fixture', messages: [{ role: 'user', content: 'identity' }] }, token); assert.equal(response.status, status, response.text); assert.equal((await metrics()).inference, before, name + ': refused key must not dispatch'); };
  const issue = async (actor, name, extra = {}) => ok(await user(actor, 'keys', { project_id: seed.project.id, name, ...extra }));
  let requestA, requestB;

  await test('static-recovery-verified-sso-admin-owner-and-project-key-boundaries', async row => {
    assert.equal((await request('/admin/api/state')).status, 200);
    assert.equal((await user('admin', '/admin/api/state')).status, 200);
    assert.equal((await user('a', '/admin/api/state')).status, 403);
    assert.equal((await request('/admin/api/state', undefined, seed.keys.a.token)).status, 401);
    assert.equal((await request('/user/api/me', undefined, adminKey)).status, 401, 'recovery keys do not impersonate a portal owner');
    row.authClasses = ['static-recovery', 'verified-sso-admin', 'portal-owner', 'project-key'];
  });
  await test('untrusted-sso-claims-never-autoprovision-a-principal', async row => {
    const subject = { subject: 'qualification-forged', name: 'Must not provision', email: 'forged@example.test' };
    for (const secret of ['', 'fixture-wrong-sso-assertion']) {
      const response = await ownerRequest({ origin, ssoSecret: secret, actor: subject, path: '/user/api/me' }); assert.equal(response.status, 401, response.text);
    }
    const missing = await ownerRequest({ origin, ssoSecret, actor: { ...subject, subject: '' }, path: '/user/api/me' }); assert.equal(missing.status, 401, missing.text);
    const principals = await admin('principals?limit=200'); assert.ok(!principals.principals.some(item => item.external_subject === 'authentik:qualification-forged')); row.rejectedAssertions = 3;
  });
  await test('portal-and-sso-admin-mutations-require-same-origin', async row => {
    for (const [includeOrigin, headers] of [[false, {}], [true, { Origin: 'https://foreign.invalid' }], [true, { Origin: 'null' }]]) {
      const response = await user('a', 'keys', { project_id: seed.project.id, name: 'Must not issue from another origin' }, { includeOrigin, headers }); assert.equal(response.status, 403, response.text);
    }
    const adminDenied = await user('admin', '/admin/api/projects', { slug: 'must-not-create', name: 'Must not create' }, { includeOrigin: false }); assert.equal(adminDenied.status, 403, adminDenied.text);
    const tls = await user('a', 'keys', { project_id: seed.project.id, name: 'Trusted forwarded TLS origin' }, { headers: { Origin: origin.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' } });
    const issued = ok(tls); assert.equal(issued.key.principal_id, seed.actors.a.id); ok(await user('a', 'keys/' + issued.key.id, undefined, { method: 'DELETE' })); row.rejectedOrigins = 4;
  });
  await test('owner-is-server-derived-and-foreign-project-viewer-cannot-mint', async row => {
    const own = await issue('a', 'Server-derived owner', { principal_id: seed.actors.b.id }); assert.equal(own.key.principal_id, seed.actors.a.id);
    assert.equal((await user('a', 'keys', { project_id: seed.foreign.id, name: 'Foreign project forbidden' })).status, 403);
    assert.equal((await user('viewer', 'keys', { project_id: seed.project.id, name: 'Viewer forbidden' })).status, 403);
    const me = ok(await user('a', 'me')); assert.equal(me.principal.id, seed.actors.a.id); assert.ok(!me.projects.some(item => item.id === seed.foreign.id)); row.ownedPrincipal = seed.actors.a.id;
  });
  await test('connection-metadata-is-write-only-and-owner-scoped', async row => {
    const mine = ok(await user('a', 'connections')), theirs = ok(await user('b', 'connections'));
    const a = mine.connections ?? [], b = theirs.connections ?? [];
    assert.ok(a.some(item => item.id === seed.connections.a.id)); assert.ok(!a.some(item => item.id === seed.connections.b.id));
    assert.ok(b.some(item => item.id === seed.connections.b.id));
    for (const secret of ['fixture-iam-a-one', 'fixture-iam-b']) assert.ok(!JSON.stringify([mine, theirs]).includes(secret), 'connection listing must not echo credentials'); row.ownerConnections = a.length;
  });
  await test('actual-private-human-and-service-system-credentials-remain-distinct', async row => {
    requestA = await infer('owner-a', seed.keys.a.token, 'a-one'); requestB = await infer('owner-b', seed.keys.b.token, 'b');
    const service = await admin('keys', { project_id: seed.project.id, name: 'IAM system service' }); await infer('service-system', service.token, 'system');
    await infer('static-system', adminKey, 'system'); row.credentialClasses = ['human-a', 'human-b', 'service-system', 'static-system'];
  });
  await test('named-default-rotation-foreign-refusal-and-promotion-use-actual-secrets', async row => {
    let secondary;
    try {
      const value = ok(await user('a', 'connections', { provider_id: 'iam-chat', connection_name: 'owner-secondary', credential_kind: 'api_key', secret: 'fixture-iam-a-two', make_default: true })); secondary = value.connection ?? value;
      await infer('default-two', seed.keys.a.token, 'a-two');
      assert.equal((await user('b', 'connections/' + secondary.id, undefined, { method: 'DELETE' })).status, 404);
      await infer('foreign-revoke-not-consumed', seed.keys.a.token, 'a-two');
      const rotated = ok(await user('a', 'connections', { provider_id: 'iam-chat', connection_name: 'owner-secondary', credential_kind: 'api_key', secret: 'fixture-iam-a-two-rotated', make_default: true }));
      assert.equal((rotated.connection ?? rotated).id, secondary.id); await infer('rotated-two', seed.keys.a.token, 'a-two-rotated');
    } finally { if (secondary) ok(await user('a', 'connections/' + secondary.id, undefined, { method: 'DELETE' })); }
    await infer('promoted-original', seed.keys.a.token, 'a-one');
    const listed = ok(await user('a', 'connections')).connections; assert.equal(listed.find(item => item.id === seed.connections.a.id)?.is_default, true); row.defaultPromoted = true;
  });
  await test('endpoint-and-credential-edits-preserve-independent-full-config-values', async row => {
    const original = 'http://upstream:18889/iam/chat/v1', alternate = 'http://upstream:18889/iam/alternate/v1';
    const service = await admin('keys', { project_id: seed.project.id, name: 'IAM endpoint preservation' });
    try {
      await admin('providers', { id: 'iam-chat', registry_id: 'openrouter', base_url: alternate }); await infer('endpoint-edit', service.token, 'system'); assert.equal((await calls()).at(-1).kind, 'alternate');
      const current = (await admin('state')).providers.find(item => item.id === 'iam-chat'); assert.equal(current.base_url, alternate);
      await admin('providers', { id: 'iam-chat', registry_id: 'openrouter', base_url: current.base_url, api_key: 'fixture-iam-system-rotated' }); await infer('key-edit', service.token, 'system-rotated'); assert.equal((await calls()).at(-1).kind, 'alternate'); row.independentEdits = true;
    } finally {
      await admin('providers', { id: 'iam-chat', registry_id: 'openrouter', base_url: original, api_key: 'fixture-iam-system' });
      for (const actor of ['a', 'b']) await admin('providers/iam-chat/refresh?principal_id=' + seed.actors[actor].id, {});
    }
  });
  await test('reveal-requires-owner-or-admin-and-is-never-cacheable', async row => {
    const mine = await user('a', 'keys/' + seed.keys.a.key.id + '/reveal', {}); assert.equal(mine.status, 200, mine.text); assert.equal(mine.json.token, seed.keys.a.token); assert.equal(mine.headers['cache-control'], 'no-store');
    const foreign = await user('b', 'keys/' + seed.keys.a.key.id + '/reveal', {}); assert.equal(foreign.status, 404, foreign.text);
    const recovered = await request('/admin/api/keys/' + seed.keys.a.key.id + '/reveal', {}); registerSecret(JSON.parse(recovered.text).token); assert.equal(recovered.status, 200); assert.equal(JSON.parse(recovered.text).token, seed.keys.a.token); assert.equal(recovered.headers['cache-control'], 'no-store');
    assert.equal((await request('/admin/api/keys/' + seed.keys.a.key.id + '/reveal', {}, seed.keys.a.token)).status, 401); row.authorizedRecoveries = 2;
  });
  await test('owner-key-update-preserves-identity-and-clears-explicit-expiry', async row => {
    const key = await issue('a', 'Owner editable key', { expires_at: Math.floor(Date.now() / 1000) + 3600, daily_requests: 2 });
    ok(await user('a', 'keys/' + key.key.id + '/update', { name: 'Owner renamed key', expires_at: 0 }));
    const current = ok(await user('a', 'me')).keys.find(item => item.id === key.key.id); assert.ok(current); assert.equal(current.principal_id, seed.actors.a.id); assert.equal(current.project_id, seed.project.id); assert.equal(current.expires_at ?? 0, 0);
    const limits = ok(await user('a', 'keys/' + key.key.id + '/limits')).limits; assert.ok(limits.some(item => item.scope === 'key' && item.field === 'daily_requests' && item.limit === 2)); row.expiryCleared = true;
  });
  await test('admin-managed-key-policy-cannot-be-broadened-by-owner', async row => {
    const key = await admin('keys', { project_id: seed.project.id, principal_id: seed.actors.a.id, name: 'Admin locked owner key', allowed_providers: ['iam-chat'], allowed_models: ['iam-chat/fixture'], daily_requests: 1 });
    for (const body of [{ allowed_providers: [] }, { allowed_models: [] }, { daily_requests: 0 }, { expires_at: 0 }, { disabled: false }]) assert.equal((await user('a', 'keys/' + key.key.id + '/update', body)).status, 403);
    ok(await user('a', 'keys/' + key.key.id + '/update', { admin_managed: false }));
    assert.equal((await user('a', 'keys/' + key.key.id + '/update', { daily_requests: 0 })).status, 403, 'an ignored client field must not clear the server-owned lock');
    const before = (await metrics()).inference;
    const excluded = await request('/v1/chat/completions', { model: 'iam-chat/blocked', messages: [{ role: 'user', content: 'identity' }] }, key.token);
    assert.equal(excluded.status, 403, excluded.text); assert.equal((await metrics()).inference, before);
    ok(await user('a', 'keys/' + key.key.id, undefined, { method: 'DELETE' })); await refuseKey('locked revoked', key.token); row.lockedPatches = 5;
  });
  await test('project-policy-replacement-and-static-recovery-bypass-remain-distinct', async row => {
    const project = await admin('projects', { slug: 'iam-policy', name: 'IAM policy intersection' }); await admin('memberships', { project_id: project.id, principal_id: seed.actors.a.id, role: 'owner' });
    const key = ok(await user('a', 'keys', { project_id: project.id, name: 'Project policy caller' }));
    await admin(`projects/${project.id}/policy`, { allowed_providers: ['iam-chat'], allowed_models: ['iam-chat/fixture'], daily_requests: 10 });
    const before = (await metrics()).inference;
    const denied = await request('/v1/chat/completions', { model: 'iam-chat/blocked', messages: [{ role: 'user', content: 'identity' }] }, key.token); assert.equal(denied.status, 403, denied.text); assert.equal((await metrics()).inference, before);
    const recovery = await request('/v1/chat/completions', { model: 'iam-chat/blocked', messages: [{ role: 'user', content: 'identity' }] }); assert.equal(recovery.status, 402, recovery.text); assert.equal((await metrics()).inference, before + 1);
    const policy = await admin(`projects/${project.id}/policy`);
    const invalid = await request('/admin/api/projects/' + project.id + '/policy', { allowed_routes: ['must-not-be-project-policy'], routes_only: true }); assert.equal(invalid.status, 400, invalid.text); assert.deepEqual(await admin(`projects/${project.id}/policy`), policy); row.projectAndKeyIntersection = true;
  });
  await test('expired-disabled-and-revoked-keys-never-regain-authentication-from-stale-patches', async row => {
    const expired = await issue('a', 'Expired qualification key'); await admin('keys/update', { id: expired.key.id, expires_at: Math.floor(Date.now() / 1000) - 60 }); await refuseKey('expired', expired.token);
    const stale = await user('a', 'keys/' + expired.key.id + '/update', { disabled: false }); assert.equal(stale.status, 403, stale.text); await refuseKey('expired after stale enable', expired.token);
    const disabled = await issue('a', 'Disabled qualification key'); ok(await user('a', 'keys/' + disabled.key.id + '/update', { disabled: true })); await refuseKey('disabled', disabled.token);
    const revoked = await issue('a', 'Revoked qualification key'); ok(await user('a', 'keys/' + revoked.key.id, undefined, { method: 'DELETE' })); await refuseKey('revoked', revoked.token);
    assert.equal((await user('a', 'keys/' + revoked.key.id + '/update', { disabled: false })).status, 400);
    const adminStale = await request('/admin/api/keys/update', { id: revoked.key.id, disabled: false }); assert.equal(adminStale.status, 400, adminStale.text); await refuseKey('revoked after stale admin enable', revoked.token); row.refusedStatuses = ['expired', 'disabled', 'revoked'];
  });
  await test('membership-removal-revokes-its-keys-and-readding-does-not-reactivate-them', async row => {
    const project = await admin('projects', { slug: 'iam-membership', name: 'IAM membership lifecycle' }); await admin('memberships', { project_id: project.id, principal_id: seed.actors.a.id, role: 'member' });
    const key = ok(await user('a', 'keys', { project_id: project.id, name: 'Membership-bound key' })); await infer('membership-before', key.token, 'a-one');
    const removed = await fetch(origin + `/admin/api/memberships?project_id=${project.id}&principal_id=${seed.actors.a.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminKey }, signal: AbortSignal.timeout(5000) }); assert.equal(removed.status, 200); await removed.json();
    await refuseKey('membership removed', key.token); assert.equal((await user('a', 'keys', { project_id: project.id, name: 'No membership' })).status, 403);
    await admin('memberships', { project_id: project.id, principal_id: seed.actors.a.id, role: 'member' }); await refuseKey('membership restored old key', key.token); row.oldKeyRemainsRevoked = true;
  });
  await test('bulk-deletion-refuses-live-or-foreign-keys-and-preserves-history-tombstones', async row => {
    const key = await issue('a', 'Deleted qualification key'); const response = await infer('deleted-key-history', key.token, 'a-one');
    const refused = ok(await user('a', 'keys/delete', { ids: [key.key.id, seed.keys.b.key.id] })); assert.deepEqual(refused.deleted, []); assert.equal(refused.refused.length, 2);
    ok(await user('a', 'keys/' + key.key.id, undefined, { method: 'DELETE' })); const deleted = ok(await user('a', 'keys/delete', { ids: [key.key.id, seed.keys.b.key.id] })); assert.deepEqual(deleted.deleted, [key.key.id]); assert.equal(deleted.refused.length, 1);
    await refuseKey('deleted', key.token); await infer('foreign-bulk-not-consumed', seed.keys.b.token, 'b');
    const logs = await admin('requests?request_id=' + response.requestId); const records = logs.requests ?? logs.rows ?? logs; assert.equal(records.length, 1); assert.equal(records[0].key_id, key.key.id); assert.equal(records[0].principal_id, seed.actors.a.id); row.historyRetained = true;
  });
  await test('owner-requests-usage-and-audit-cannot-select-another-principal', async row => {
    assert.ok(requestA && requestB);
    const result = ok(await user('a', 'requests?principal_id=' + seed.actors.b.id + '&limit=200'));
    const rows = result.requests ?? result.rows ?? result; assert.ok(rows.some(item => item.request_id === requestA.requestId)); assert.ok(rows.every(item => item.principal_id === seed.actors.a.id)); assert.ok(!rows.some(item => item.request_id === requestB.requestId));
    const usage = await user('a', 'usage?principal_id=' + seed.actors.b.id); assert.equal(usage.status, 200, usage.text); assert.ok(!usage.text.includes(seed.keys.b.key.id));
    const audit = await user('a', 'audit?limit=200'); assert.equal(audit.status, 200, audit.text); assert.ok(!audit.text.includes(seed.keys.b.token)); row.ownerPrincipal = seed.actors.a.id;
  });
  await test('synthetic-service-account-upload-and-errors-never-echo-key-material', async row => {
    await admin('providers', { id: 'iam-vertex', type: 'vertex_ai', base_url: 'http://upstream:18889/media/vertex/v1', project: 'fixture-project', location: 'global' });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }); registerSecret(privateKey);
    const record = { type: 'service_account', project_id: 'fixture-project', private_key_id: 'fixture-generated-key', private_key: privateKey, client_email: 'generated@example.test', token_uri: 'https://oauth2.googleapis.com/token' };
    const upload = async (name, value) => {
      const body = new FormData(); body.set('provider_id', 'iam-vertex'); body.set('connection_name', name); body.set('credential_kind', 'gcp_service_account'); body.set('secret', new Blob([JSON.stringify(value)], { type: 'application/json' }), 'generated-service-account.json');
      return user('a', 'connections', body);
    };
    const accepted = await upload('generated-account', record); ok(accepted); assert.ok(!accepted.text.includes(privateKey));
    const denied = await upload('foreign-token-endpoint', { ...record, token_uri: 'https://foreign.invalid/token' }); assert.equal(denied.status, 400, denied.text); assert.ok(!denied.text.includes(privateKey) && !denied.text.includes(privateKey.split('\n')[1]), 'credential errors must not echo private material'); row.generatedOnly = true;
  });
  await test('admin-audit-records-mutations-without-credentials-or-recovery-tokens', async row => {
    const audit = await admin('audit?limit=200'); const text = JSON.stringify(audit);
    for (const secret of [adminKey, ssoSecret, seed.keys.a.token, seed.keys.b.token, 'fixture-iam-a-one', 'fixture-iam-b', 'fixture-iam-system', 'fixture-iam-system-rotated']) assert.ok(!text.includes(secret), 'audit must not retain credentials');
    const entries = audit.events ?? audit.rows ?? audit; assert.ok(Array.isArray(entries) && entries.length > 0); row.auditEntries = entries.length;
  });
  evidence.pass = evidence.cases.length === 18 && evidence.cases.every(row => row.pass); save('iam-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
