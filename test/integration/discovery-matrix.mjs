import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

export async function runDiscoveryMatrix({ admin, publicCall, metrics, save }) {
  const result = { boundary: 'Installed first bare-alias discovery is scoped to its caller and leaves on request cancellation', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('discovery-matrix.json', result); } };
  await test('initial-uncached-alias-discovery-cancels-upstream-and-does-not-persist-a-catalog', async row => {
    await admin('providers', { id: 'discovery-pending', registry_id: 'openai', base_url: 'http://upstream:18889/discovery/v1', api_key: 'fixture-discovery-token' });
    const project = await admin('projects', { slug: 'discovery-cancellation', name: 'Discovery cancellation project' });
    const caller = await admin('keys', { project_id: project.id, name: 'Scoped discovery caller', allowed_providers: ['discovery-pending'] });
    const input = { model: 'fixture-discovery-model', messages: [{ role: 'user', content: 'discover once' }], stream: false };
    const before = (await metrics()).discovery; assert.equal(before.listed, 0);
    const controller = new AbortController();
    const response = fetch(process.env.REPLAY_ORIGIN + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + caller.token, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
    for (let attempt = 0; attempt < 80 && (await metrics()).discovery.listed === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await metrics()).discovery.listed, 1, 'the initial request must have reached the actual catalog upstream');
    controller.abort(); await assert.rejects(response);
    for (let attempt = 0; attempt < 80 && (await metrics()).discovery.left === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    const abandoned = (await metrics()).discovery; assert.equal(abandoned.left, 1); assert.equal(abandoned.inferred, 0); assert.equal(abandoned.completed, 0);
    const cached = await admin('providers/discovery-pending/models', {}); assert.equal(cached.count, 0, 'an aborted first discovery cannot publish a model');
    const release = await fetch('http://127.0.0.1:18889/discovery/control/release', { method: 'POST', signal: AbortSignal.timeout(2000) }); assert.equal(release.status, 200); await release.json();
    const allowed = await publicCall('discovery-retried-after-cancel', '/v1/chat/completions', input, caller.token); assert.equal(allowed.status, 200, allowed.text);
    assert.equal(JSON.parse(allowed.text).choices[0].message.content, 'discovered-fixture');
    const after = (await metrics()).discovery; assert.equal(after.listed, 2); assert.equal(after.completed, 1); assert.equal(after.inferred, 1); row.abandonedCatalogs = 1; row.retriedDispatches = 1;
    writeFileSync('/artifacts/discovery-seed-private.json', JSON.stringify({ token: caller.token, listed: after.listed, completed: after.completed, inferred: after.inferred }) + '\n', { mode: 0o600 });
  });
  result.pass = result.cases.length === 1 && result.cases.every(row => row.pass); save('discovery-matrix.json', result);
  assert.equal(result.pass, true, result.cases.filter(row => !row.pass).map(row => row.error).join('\n'));
}
