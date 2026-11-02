import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runInstalledRateRecovery(mode) {
  assert.equal(mode, 'restart'); const root = process.env.REPLAY_ARTIFACTS ?? '/artifacts';
  const seed = JSON.parse(readFileSync(join(root, 'caller-rate-seed-private.json'), 'utf8'));
  const result = { mode, boundary: 'Process-local caller allowance resets on restart while project request use remains durable', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = String(error.message).replaceAll(seed.token, '[temporary-key]'); } };
  await test('caller-rate-resets-after-process-restart-but-project-quota-persists', async row => {
    assert.equal(Math.floor(Date.now() / 60000), seed.minute, 'the restart must be observed within the same UTC minute');
    const origin = process.env.REPLAY_ORIGIN;
    const payload = { model: 'caller-rate-fixture/fixture', messages: [{ role: 'user', content: 'routing:success' }], temperature: 0.125, max_tokens: 17 };
    const response = await fetch(origin + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + seed.token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, 'a restart must clear only the process-local caller window'); await response.json();
    const admin = await fetch(origin + `/admin/api/keys/${seed.keyId}/limits`, { headers: { Authorization: 'Bearer ' + process.env.REPLAY_ADMIN_KEY }, signal: AbortSignal.timeout(5000) });
    assert.equal(admin.status, 200); const limits = (await admin.json()).limits;
    assert.ok(limits.some(limit => limit.scope === 'caller' && limit.field === 'rate_limit_per_minute' && limit.used === 1 && limit.limit === 2));
    assert.ok(limits.some(limit => limit.scope === 'project' && limit.field === 'daily_requests' && limit.used === 3 && limit.limit === 10));
    row.callerUsed = 1; row.durableProjectUsed = 3;
  });
  result.pass = result.cases.length === 1 && result.cases.every(row => row.pass);
  writeFileSync(join(root, 'caller-rate-restart-results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
  return result;
}
