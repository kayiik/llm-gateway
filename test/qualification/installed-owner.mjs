import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownerRequest } from './owner-fixture.mjs';

export async function runInstalledOwnerRecovery({ origin, adminKey, ssoSecret, artifacts, mode }) {
  const seed = JSON.parse(readFileSync(join(artifacts, 'owner-seed-private.json'), 'utf8'));
  const secrets = [ssoSecret, ...Object.values(seed.keys).map(item => item.token)];
  const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[temporary-key]'), String(value));
  const result = { boundary: 'Original SSO subjects, owned project keys and private provider credentials on the installed state', mode, pass: false, cases: [] };
  for (const actor of ['a', 'b']) {
    const row = { name: 'preserved-owner-' + actor + '-identity-key-and-credential', pass: false }; result.cases.push(row);
    try {
      const me = await ownerRequest({ origin, ssoSecret, actor, path: '/user/api/me' });
      assert.equal(me.status, 200); assert.equal(me.json.principal.id, seed.actors[actor].id);
      const key = me.json.keys.find(item => item.id === seed.keys[actor].key.id);
      assert.ok(key); assert.equal(key.principal_id, seed.actors[actor].id); assert.equal(key.project_id, seed.project.id);
      const reveal = await ownerRequest({ origin, ssoSecret, actor, path: '/user/api/keys/' + key.id + '/reveal', body: {} });
      assert.equal(reveal.status, 200); assert.ok(reveal.json.token === seed.keys[actor].token, 'the original owner token must remain decryptable'); assert.equal(reveal.headers['cache-control'], 'no-store');
      const response = await fetch(origin + '/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + seed.keys[actor].token, 'Content-Type': 'application/json', 'X-Request-ID': `owner-${mode}-${actor}` },
        body: JSON.stringify({ model: 'iam-chat/fixture', messages: [{ role: 'user', content: 'identity' }], max_tokens: 17, temperature: 0.125 }), signal: AbortSignal.timeout(10000),
      });
      const payload = await response.json(); assert.equal(response.status, 200);
      assert.equal(payload.choices[0].message.content, 'credential:' + (actor === 'a' ? 'a-one' : 'b'));
      const cached = await ownerRequest({ origin, ssoSecret, actor, path: '/user/api/models' }); assert.equal(cached.status, 200); row.cachedModelsBeforeRefresh = cached.json.data.length;
      // Catalog reads are deliberately cache-only. Re-observe the installed
      // caller's catalog after preservation checks, before browser selection.
      for (const provider of ['iam-chat', 'iam-tools']) {
        const refresh = await fetch(origin + '/admin/api/providers/' + provider + '/refresh?principal_id=' + seed.actors[actor].id, { method: 'POST', headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
        assert.ok(refresh.ok, 'the preserved private credential must still discover its own models'); await refresh.json();
      }
      row.catalogReobservedWithoutInference = true; row.pass = true;
    } catch (error) { row.error = redact(error.message); }
  }
  if (seed.extension) {
    const row = { name: 'preserved-extension-address-and-secret-decryption', pass: false }; result.cases.push(row);
    try {
      const headers = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
      const response = await fetch(origin + '/admin/api/extensions', { headers, signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
      const record = (await response.json()).extensions.find(item => item.id === seed.extension.id); assert.ok(record); assert.equal(record.name, seed.extension.name); assert.equal(record.url, seed.extension.url); assert.equal(record.secret_set, true);
      const checked = await fetch(origin + '/admin/api/extensions/' + seed.extension.id + '/check', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(10000) }); assert.equal(checked.status, 200); const status = await checked.json(); assert.equal(status.reachable, true); assert.equal(status.version, '0.0.4'); row.pass = true;
    } catch (error) { row.error = redact(error.message); }
  }
  result.pass = result.cases.length === (seed.extension ? 3 : 2) && result.cases.every(row => row.pass);
  return result;
}
