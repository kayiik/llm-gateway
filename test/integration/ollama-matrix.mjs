import assert from 'node:assert/strict';

export async function runOllamaMatrix({ admin, request, publicCall, metrics, save }) {
  const result = { boundary: 'Installed local Ollama native daemon catalog/Chat with explicit adaptation and real source usage; no external daemon entitlement', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('ollama-matrix.json', result); } };
  const model = 'ollama-local/fixture-ollama:latest';
  await test('ollama-native-local-catalog-and-credentialless-binding', async row => {
    await admin('providers', { id: 'ollama-local', registry_id: 'ollama', base_url: 'http://upstream:18889' });
    const before = (await metrics()).ollama?.catalogs ?? 0;
    await admin('providers/ollama-local/refresh', {});
    const listed = await request('/v1/models'); assert.equal(listed.status, 200, listed.text);
    assert.ok(JSON.parse(listed.text).data.some(item => item.id === model));
    assert.equal((await metrics()).ollama.catalogs, before + 1);
    row.catalogs = 1;
  });
  await test('ollama-messages-deny-before-io-then-explicit-adaptation', async row => {
    const before = (await metrics()).ollama.calls.length;
    const input = { model, max_tokens: 16, messages: [{ role: 'user', content: 'Respond from the fixture.' }] };
    const denied = await publicCall('ollama-messages-deny', '/v1/messages', input);
    assert.equal(denied.status, 400, denied.text); assert.match(denied.text, /adaptation_required/);
    assert.equal((await metrics()).ollama.calls.length, before, 'refusal must precede source I/O');
    const allowed = await publicCall('ollama-messages-allow', '/v1/messages', input, undefined, 'allow');
    assert.equal(allowed.status, 200, allowed.text); assert.match(allowed.text, /ollama-fixture-ok/);
    const after = (await metrics()).ollama; assert.deepEqual(after.calls.slice(before).map(call => [call.model, call.stream]), [['fixture-ollama:latest', false]]); row.sourceCalls = 1;
  });
  await test('ollama-chat-denies-implicit-adaptation-before-source-io', async row => {
    const before = (await metrics()).ollama.calls.length;
    const denied = await publicCall('ollama-chat-deny', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'Must refuse.' }], max_tokens: 16 });
    assert.equal(denied.status, 400, denied.text); assert.match(denied.text, /adaptation_required/);
    assert.equal((await metrics()).ollama.calls.length, before); row.sourceCalls = 0;
  });
  await test('ollama-allowed-chat-json-reports-observed-source-usage', async row => {
    const before = (await metrics()).ollama.calls.length;
    const answer = await publicCall('ollama-allowed-json', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'Respond from the fixture.' }], max_tokens: 16 }, undefined, 'allow');
    assert.equal(answer.status, 200, answer.text); const body = JSON.parse(answer.text);
    assert.equal(body.choices[0].message.content, 'ollama-fixture-ok'); assert.deepEqual(body.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    const after = (await metrics()).ollama; assert.deepEqual(after.calls.slice(before).map(call => [call.model, call.stream, call.tools]), [['fixture-ollama:latest', false, false]]); row.sourceCalls = 1;
  });
  await test('ollama-allowed-chat-sse-terminates-once', async row => {
    const before = (await metrics()).ollama.calls.length;
    const answer = await publicCall('ollama-allowed-sse', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'Respond from the fixture.' }], max_tokens: 16, stream: true }, undefined, 'allow');
    assert.equal(answer.status, 200, answer.text); assert.match(answer.contentType, /text\/event-stream/);
    assert.match(answer.text, /ollama-fixture-ok/); assert.equal(answer.text.split('data: [DONE]').length - 1, 1);
    assert.deepEqual((await metrics()).ollama.calls.slice(before).map(call => [call.model, call.stream]), [['fixture-ollama:latest', true]]); row.sourceCalls = 1;
  });
  await test('ollama-allowed-chat-tool-call-survives-daemon-conversion', async row => {
    const before = (await metrics()).ollama.calls.length;
    const answer = await publicCall('ollama-allowed-tool', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'Call add.' }], tools: [{ type: 'function', function: { name: 'add', parameters: { type: 'object', properties: { a: { type: 'integer' } } } } }], max_tokens: 16 }, undefined, 'allow');
    assert.equal(answer.status, 200, answer.text); const choice = JSON.parse(answer.text).choices[0];
    assert.equal(choice.finish_reason, 'tool_calls'); assert.equal(choice.message.tool_calls[0].function.name, 'add');
    assert.deepEqual((await metrics()).ollama.calls.slice(before).map(call => [call.model, call.tools]), [['fixture-ollama:latest', true]]); row.sourceCalls = 1;
  });
  result.pass = result.cases.length === 6 && result.cases.every(row => row.pass); save('ollama-matrix.json', result);
  assert.equal(result.pass, true, result.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
