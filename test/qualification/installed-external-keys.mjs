import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runInstalledExternalKeys(mode) {
  assert.equal(mode, 'run'); const root = process.env.REPLAY_ARTIFACTS ?? '/artifacts';
  const seed = JSON.parse(readFileSync(join(root, 'state-seed-private.json'), 'utf8'));
  const origin = process.env.REPLAY_ORIGIN, adminKey = process.env.REPLAY_ADMIN_KEY;
  let healthy = false;
  for (let attempt = 0; attempt < 60 && !healthy; attempt++) {
    try { healthy = (await fetch(origin + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { /* startup */ }
    if (!healthy) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, 'the copied external-key Gateway must be healthy before exercising the source');
  const result = { boundary: 'Isolated copied-state external file/HTTP key snapshots, ETag, last-known-good, rotation, stale fail-closed and project charging', pass: false, cases: [] };
  const secrets = ['fixture-external-file-key', 'fixture-external-http-one', 'fixture-external-http-two', 'fixture-external-source-token', adminKey];
  const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[temporary-key]'), String(value));
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = redact(error.message); } };
  const metric = async () => (await (await fetch('http://127.0.0.1:18889/metrics', { signal: AbortSignal.timeout(2000) })).json()).externalKeys;
  const modeOf = async mode => { const response = await fetch('http://127.0.0.1:18889/external-keys/control', { method: 'POST', body: JSON.stringify({ mode }), signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); await response.json(); };
  const authenticated = async token => {
    const response = await fetch(origin + '/v1/models', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) }); await response.text(); return response.status;
  };
  const inference = async token => {
    const response = await fetch(origin + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'preserved-route', messages: [{ role: 'user', content: 'result-fixture' }] }), signal: AbortSignal.timeout(5000) });
    const text = await response.text(); assert.equal(response.status, 200, redact(text)); return JSON.parse(text);
  };
  const limits = async () => {
    const response = await fetch(origin + '/admin/api/projects/' + seed.project.id + '/limits', { headers: { Authorization: 'Bearer ' + adminKey }, signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200); return (await response.json()).limits.find(item => item.field === 'daily_requests')?.used;
  };
  let initialProjectUsed;
  await test('external-file-and-http-keys-use-the-existing-project-without-admin-rights', async row => {
    initialProjectUsed = await limits(); assert.ok(Number.isInteger(initialProjectUsed));
    for (const token of ['fixture-external-file-key', 'fixture-external-http-one']) {
      assert.equal(await authenticated(token), 200); const answer = await inference(token); assert.ok(answer.choices[0].message.content);
      const denied = await fetch(origin + '/admin/api/state', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3000) }); assert.equal(denied.status, 401); await denied.text();
    }
    assert.equal(await limits(), initialProjectUsed + 2); row.projectRequests = 2;
  });
  await test('http-source-sends-conditional-etag-and-keeps-the-good-snapshot-on-invalid-replacement', async row => {
    for (let attempt = 0; attempt < 30 && !(await metric()).requests.some(item => item.etag === '"one"'); attempt++) await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok((await metric()).requests.some(item => item.etag === '"one"')); assert.ok((await metric()).responses.unchanged > 0);
    await modeOf('invalid');
    for (let attempt = 0; attempt < 30 && (await metric()).responses.invalid === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok((await metric()).responses.invalid > 0); assert.equal(await authenticated('fixture-external-http-one'), 200);
    assert.equal(await authenticated('fixture-external-http-two'), 401); row.goodKeyRetained = true;
  });
  await test('valid-http-replacement-revokes-old-token-without-revoking-the-file-key', async row => {
    await modeOf('two');
    for (let attempt = 0; attempt < 40 && await authenticated('fixture-external-http-one') !== 401; attempt++) await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await authenticated('fixture-external-http-one'), 401);
    assert.equal(await authenticated('fixture-external-http-two'), 200); assert.ok((await metric()).responses.two > 0);
    await inference('fixture-external-http-two'); assert.equal(await authenticated('fixture-external-file-key'), 200);
    assert.equal(await limits(), initialProjectUsed + 3); row.newKeyAdmitted = true;
  });
  await test('http-source-unavailability-expires-only-its-own-last-known-good-key', async row => {
    await modeOf('unavailable');
    for (let attempt = 0; attempt < 65 && await authenticated('fixture-external-http-two') !== 401; attempt++) await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await authenticated('fixture-external-http-two'), 401);
    assert.equal(await authenticated('fixture-external-file-key'), 200); await inference('fixture-external-file-key');
    assert.equal(await limits(), initialProjectUsed + 4);
    assert.ok((await metric()).responses.unavailable > 0); row.staleHTTPRefused = true; row.fileStillCurrent = true;
  });
  result.pass = result.cases.length === 4 && result.cases.every(row => row.pass);
  writeFileSync(join(root, 'external-keys-results.json'), redact(JSON.stringify(result, null, 2)) + '\n', { mode: 0o600 }); console.log(JSON.stringify({ pass: result.pass, cases: result.cases.map(item => ({ name: item.name, pass: item.pass, error: item.error })) })); if (!result.pass) process.exitCode = 1;
  return result;
}
