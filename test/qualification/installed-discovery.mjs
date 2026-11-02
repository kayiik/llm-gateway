import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runInstalledDiscoveryRecovery(mode) {
  assert.equal(mode, 'restart'); const root = process.env.REPLAY_ARTIFACTS ?? '/artifacts';
  const seed = JSON.parse(readFileSync(join(root, 'discovery-seed-private.json'), 'utf8'));
  const current = JSON.parse(readFileSync(join(root, 'discovery-current-private.json'), 'utf8'));
  const result = { mode, boundary: 'Aged disposable catalog serves stale aliases without blocking and coalesces one pending background refresh', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = String(error.message).replaceAll(seed.token, '[temporary-key]'); } };
  await test('stale-aliases-serve-immediately-while-one-background-refresh-is-held', async row => {
    const origin = process.env.REPLAY_ORIGIN;
    const metrics = async () => (await (await fetch('http://127.0.0.1:18889/metrics', { signal: AbortSignal.timeout(2000) })).json()).discovery;
    const old = await metrics();
    assert.ok(current.listed >= seed.listed && current.completed >= seed.completed, 'the aborted request and retry must remain in the measured source history');
    assert.ok(old.listed >= current.listed && old.listed <= current.listed + 1, 'startup may begin the one coalesced stale refresh before an alias arrives');
    assert.equal(old.completed, current.completed, 'the restart refresh is held, never published early');
    const body = JSON.stringify({ model: 'fixture-discovery-model', messages: [{ role: 'user', content: 'stale stays usable' }] });
    const started = Date.now();
    const answered = await Promise.all([0, 1].map(() => fetch(origin + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + seed.token, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) })));
    for (const response of answered) { assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, 'discovered-fixture'); }
    assert.ok(Date.now() - started < 3000, 'the stale model must not wait for a held catalog refresh');
    for (let attempt = 0; attempt < 80 && (await metrics()).listed === old.listed; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    const held = await metrics(); assert.equal(held.listed, current.listed + 1, 'parallel aliases coalesce one background refresh');
    assert.equal(held.completed, current.completed, 'the background refresh remains held'); assert.equal(held.inferred, current.inferred + 2);
    const release = await fetch('http://127.0.0.1:18889/discovery/control/release', { method: 'POST', signal: AbortSignal.timeout(2000) }); assert.equal(release.status, 200); await release.json();
    for (let attempt = 0; attempt < 80 && (await metrics()).completed === current.completed; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await metrics()).completed, current.completed + 1); row.staleDispatches = 2; row.backgroundRefreshes = 1;
  });
  result.pass = result.cases.length === 1 && result.cases.every(row => row.pass);
  writeFileSync(join(root, 'discovery-restart-results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
  return result;
}
