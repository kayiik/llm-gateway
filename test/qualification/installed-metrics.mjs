import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const requests = text => text.split(/\r?\n/).filter(line => line.startsWith('llmgw_http_requests_total{')).reduce((total, line) => total + Number(line.match(/ (\d+)$/)?.[1] ?? 0), 0);

export async function runInstalledMetricsRecovery(mode) {
  assert.equal(mode, 'restart'); const root = process.env.REPLAY_ARTIFACTS ?? '/artifacts';
  const before = JSON.parse(readFileSync(join(root, 'metrics-seed-private.json'), 'utf8'));
  const result = { mode, boundary: 'Actual process-local Gateway counters reset on restart; build identity remains the same', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } };
  await test('metrics-counters-reset-without-changing-the-installed-build', async row => {
    const response = await fetch(process.env.REPLAY_ORIGIN + '/metrics', { headers: { Authorization: 'Bearer fixture-metrics-token' }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); const text = await response.text();
    const build = text.split(/\r?\n/).find(line => line.startsWith('llmgw_build_info{'));
    assert.equal(build, before.build, 'a process restart cannot silently change the running build');
    const now = requests(text); assert.ok(now < before.requests, `process counter did not reset: ${now} >= ${before.requests}`);
    row.requestCountBefore = before.requests; row.requestCountAfter = now;
  });
  result.pass = result.cases.every(item => item.pass);
  writeFileSync(join(root, 'metrics-restart-results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
  return result;
}
