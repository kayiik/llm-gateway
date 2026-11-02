import assert from 'node:assert/strict';

export async function runPhaseMatrix({ admin, request, publicCall, metrics, save }) {
  const result = { boundary: 'Native Responses retains output phase; adapted Chat/Messages cannot drop even advisory final_answer or unknown phases', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('phase-matrix.json', result); } };
  await admin('providers', { id: 'phase-responses', registry_id: 'openai', base_url: 'http://upstream:18889/clients/openai/v1', api_key: 'fixture-client-upstream-key', force_api_support: true });
  await admin('providers/phase-responses/refresh', {});
  const model = 'phase-responses/fixture-client-responses';
  for (const phase of ['', 'final_answer', 'commentary', 'future_phase']) for (const surface of ['responses', 'chat', 'messages']) await test(`native-phase-${phase || 'absent'}-${surface}`, async row => {
    const path = { responses: '/v1/responses', chat: '/v1/chat/completions', messages: '/v1/messages' }[surface];
    const message = 'phase:' + phase;
    const body = surface === 'responses' ? { model, input: message } : { model, messages: [{ role: 'user', content: message }], max_tokens: 8, ...(surface === 'chat' ? { temperature: 0 } : {}) };
    const before = (await metrics()).clients?.calls?.length ?? 0;
    const response = await publicCall(`phase-${phase || 'absent'}-${surface}`, path, body, undefined, 'allow');
    if (phase && surface !== 'responses') { assert.equal(response.status, 400, response.text); assert.match(response.text, /translation would lose output\.0\.phase/); }
    else { assert.equal(response.status, 200, response.text); if (surface === 'responses') {
      const output = JSON.parse(response.text).output[0]; assert.equal(output.phase, phase || undefined);
    } else assert.ok(response.text.includes('fixture-client-ok')); }
    assert.equal((await metrics()).clients.calls.length, before + 1, 'one native source call settles even when adapted output is refused'); row.sourceCalls = 1;
  });
  result.pass = result.cases.length === 12 && result.cases.every(row => row.pass); save('phase-matrix.json', result);
  assert.equal(result.pass, true, result.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
