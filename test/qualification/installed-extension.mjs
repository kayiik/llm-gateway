import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runInstalledExtensionRecovery(mode) {
  assert.equal(mode, 'restart'); const root = process.env.REPLAY_ARTIFACTS ?? '/artifacts';
  const seed = JSON.parse(readFileSync(join(root, 'extension-seed-private.json'), 'utf8'));
  const result = { mode, boundary: 'Installed daemon secret and personal OAuth decryption; inactive service binding remains inactive', pass: false, cases: [] };
  const secrets = [process.env.REPLAY_ADMIN_KEY, seed.owners.keys.a.token, seed.caller.token, 'fixture-extension-secret', 'fixture-extension-owner-token', 'fixture-extension-shared-token'];
  const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[temporary-key]'), String(value));
  const call = async (path, body, token = process.env.REPLAY_ADMIN_KEY) => {
    const response = await fetch(process.env.REPLAY_ORIGIN + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const text = await response.text(); return { status: response.status, text, json: JSON.parse(text) };
  };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(); row.pass = true; } catch (error) { row.error = redact(error.message); } };
  await test('saved-extension-shared-secret-still-probes-after-restart', async () => {
    const checked = await call('/admin/api/extensions/' + seed.id + '/check', {}); assert.equal(checked.status, 200); assert.equal(checked.json.reachable, true); assert.equal(checked.json.version, '0.0.4');
  });
  await test('private-extension-oauth-credentials-remain-usable-after-restart', async () => {
    for (const instance of ['ext-browser-oauth', 'ext-copilot']) {
      const refreshed = await call('/admin/api/providers/' + instance + '/refresh?principal_id=' + seed.owners.actors.a.id, {}); assert.equal(refreshed.status, 200, 'the preserved OAuth credential must still discover ' + instance);
      const response = await call('/v1/chat/completions', { model: instance + '/private-chat', messages: [{ role: 'user', content: 'private preserved' }] }, seed.owners.keys.a.token);
      assert.equal(response.status, 200, instance + ': ' + response.text); assert.equal(response.json.choices[0].message.content, 'complete-fixture');
    }
  });
  await test('disabled-copilot-service-binding-does-not-reactivate-after-restart', async () => {
    const response = await call('/v1/chat/completions', { model: 'ext-copilot/private-chat', messages: [{ role: 'user', content: 'must not dispatch' }] }, seed.caller.token); assert.ok([403, 404].includes(response.status));
  });
  result.pass = result.cases.length === 3 && result.cases.every(row => row.pass);
  writeFileSync(join(root, 'extension-restart-results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
  return result;
}
