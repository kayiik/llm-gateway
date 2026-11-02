import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runInstalledOperationalRecovery(mode) {
  assert.equal(mode, 'restart'); const root = process.env.REPLAY_ARTIFACTS ?? '/artifacts';
  const { projectQuotaSeed } = JSON.parse(readFileSync(join(root, 'operational-seed-private.json'), 'utf8'));
  const result = { mode, boundary: 'Installed target and project/key quota counters and exact limits-only edits after process restart', pass: false, cases: [] };
  const redact = value => String(value).replaceAll(projectQuotaSeed.token, '[temporary-key]').replaceAll(process.env.REPLAY_ADMIN_KEY, '[temporary-key]');
  const api = async (path, body, token = process.env.REPLAY_ADMIN_KEY) => {
    const response = await fetch(process.env.REPLAY_ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const text = await response.text(); return { status: response.status, text, json: JSON.parse(text) };
  };
  const metrics = async () => (await fetch('http://127.0.0.1:18889/metrics', { signal: AbortSignal.timeout(2000) })).json();
  const input = model => ({ model, messages: [{ role: 'user', content: 'routing:success' }], max_tokens: 17, temperature: 0.125 });
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = redact(error.message); } };
  await test('target-token-settlement-refuses-new-admission-after-restart', async row => {
    const before = (await metrics()).inference; const denied = await api('/v1/chat/completions', input('ops-token/fixture'));
    assert.equal(denied.status, 429, denied.text); assert.match(denied.text, /provider.*daily_tokens|quota/i);
    assert.equal((await metrics()).inference, before); row.upstreamCalls = 0;
  });
  await test('project-budget-aggregated-across-keys-still-refuses-after-restart', async row => {
    const before = (await metrics()).inference; const denied = await api('/v1/chat/completions', input('ops-project/fixture'), projectQuotaSeed.token);
    assert.equal(denied.status, 429, denied.text); assert.equal((await metrics()).inference, before);
    const limits = await api('/admin/api/keys/' + projectQuotaSeed.keyId + '/limits'); assert.equal(limits.status, 200, limits.text);
    assert.ok(limits.json.limits.some(limit => limit.scope === 'project' && limit.field === 'daily_requests' && limit.used === 3 && limit.limit === 3)); row.sharedProjectUsed = 3;
  });
  await test('explicitly-cleared-provider-limit-remains-cleared-after-restart', async row => {
    const state = await api('/admin/api/state'); assert.equal(state.status, 200, state.text);
    const edited = state.json.providers.find(provider => provider.id === 'ops-model'); assert.ok(edited); assert.equal(edited.usage_limits?.rpm ?? 0, 0);
    const before = (await metrics()).inference; const allowed = await api('/v1/chat/completions', input('ops-model/fixture'));
    assert.equal(allowed.status, 200, allowed.text); assert.equal((await metrics()).inference, before + 1); row.dispatched = 1;
  });
  result.pass = result.cases.length === 3 && result.cases.every(row => row.pass);
  writeFileSync(join(root, 'operational-restart-results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
  return result;
}
