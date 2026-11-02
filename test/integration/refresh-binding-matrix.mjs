import assert from 'node:assert/strict';

export async function runRefreshBindingMatrix({ admin, request, metrics, save, registerSecret }) {
  registerSecret('fixture-discovery-token');
  const result = { boundary: 'Project policy changed while a real caller-scoped catalog refresh is held; no stale-policy second dispatch', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('refresh-binding-matrix.json', result); } };
  await test('project-model-policy-change-while-first-catalog-held-fences-resumed-and-next-inference', async row => {
    await admin('providers', { id: 'refresh-binding', registry_id: 'openai', base_url: 'http://upstream:18889/discovery/v1', api_key: 'fixture-discovery-token' });
    const project = await admin('projects', { slug: 'refresh-binding-project', name: 'Refresh binding project' });
    const key = await admin('keys', { project_id: project.id, name: 'Refresh binding caller', allowed_providers: ['refresh-binding'] });
    const hold = await fetch('http://127.0.0.1:18889/discovery/control/hold', { method: 'POST', signal: AbortSignal.timeout(2000) }); assert.equal(hold.status, 200); await hold.text();
    const before = (await metrics()).discovery;
    const input = { model: 'fixture-discovery-model', messages: [{ role: 'user', content: 'Must respect changed project policy.' }] };
    const first = fetch(process.env.REPLAY_ORIGIN + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key.token, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
    try {
      for (let attempt = 0; attempt < 100 && (await metrics()).discovery.listed <= before.listed; attempt++) await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal((await metrics()).discovery.listed, before.listed + 1, 'caller must wait on the actual first catalog request');
      const changed = await admin(`projects/${project.id}/policy`, { allowed_models: ['refresh-binding/unrelated-model'] });
      assert.ok(changed);
      const release = await fetch('http://127.0.0.1:18889/discovery/control/release', { method: 'POST', signal: AbortSignal.timeout(2000) }); assert.equal(release.status, 200); await release.text();
      const resumed = await first; const resumedText = await resumed.text();
      assert.ok([400, 403, 404].includes(resumed.status), resumedText);
      assert.equal((await metrics()).discovery.inferred, before.inferred, 'a held request must not dispatch under a replaced project policy');
      const next = await request('/v1/chat/completions', input, key.token); assert.ok([400, 403, 404].includes(next.status), next.text);
      assert.equal((await metrics()).discovery.inferred, before.inferred, 'the following request must remain fenced'); row.inference = 0;
    } finally {
      const released = await fetch('http://127.0.0.1:18889/discovery/control/release', { method: 'POST', signal: AbortSignal.timeout(2000) }); await released.text();
      await first.catch(() => {});
    }
  });
  result.pass = result.cases.length === 1 && result.cases.every(row => row.pass); save('refresh-binding-matrix.json', result);
  assert.equal(result.pass, true, result.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
