import assert from 'node:assert/strict';

export async function runCompatibleMatrix({ admin, request, publicCall, metrics, save, registerSecret }) {
  registerSecret('fixture-compatible-key');
  const result = { boundary: 'Configured compatible registry instances cross the real Gateway Chat JSON/SSE boundary against credential- and model-rejecting local hosts; no vendor entitlement', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('compatible-matrix.json', result); } };
  const targets = [
    ['localai', 'localai', true], ['litellm', 'litellm', true], ['vllm', 'vllm', true], ['lmstudio', 'lmstudio', true],
    ['custom', 'custom_openai', true], ['siliconflow', 'siliconflow', true], ['nvidia', 'nvidia_nim', true], ['alibaba', 'alibaba_coding_plan', true], ['alibaba-cn', 'alibaba_coding_plan_cn', true],
    ['localai-anon', 'localai', false], ['ovh-anon', 'ovh_ai_endpoints', false],
  ];
  for (const [target, registryID, keyed] of targets) await test(`compatible-${target}-json-and-sse`, async row => {
    const id = 'compatible-' + target;
    await admin('providers', { id, registry_id: registryID, base_url: `http://upstream:18889/compatible/${target}/v1`, ...(keyed ? { api_key: 'fixture-compatible-key' } : {}) });
    await admin(`providers/${id}/refresh`, {});
    const before = (await metrics()).compatible?.calls?.length ?? 0;
    const input = { model: id + '/fixture-chat', messages: [{ role: 'user', content: 'Return the controlled answer.' }], max_tokens: 16, temperature: 0.125 };
    const answer = await publicCall('compatible-' + target + '-json', '/v1/chat/completions', input);
    assert.equal(answer.status, 200, answer.text); assert.equal(JSON.parse(answer.text).choices[0].message.content, 'compatible:' + target);
    const stream = await publicCall('compatible-' + target + '-sse', '/v1/chat/completions', { ...input, stream: true });
    assert.equal(stream.status, 200, stream.text); assert.match(stream.contentType, /text\/event-stream/);
    assert.match(stream.text, new RegExp('compatible:' + target)); assert.match(stream.text, /data: \[DONE\]/);
    const served = (await metrics()).compatible.calls.slice(before); assert.deepEqual(served.map(item => [item.target, item.stream, item.authorized]), [[target, false, keyed], [target, true, keyed]]);
    row.upstreamCalls = 2; row.credentialKind = keyed ? 'configured-bearer' : 'anonymous';
  });
  await test('nvidia-distinct-safety-model-does-not-substitute-the-chat-model', async row => {
    const listed = await request('/v1/models'); assert.equal(listed.status, 200, listed.text);
    assert.ok(JSON.parse(listed.text).data.some(item => item.id === 'compatible-nvidia/fixture-chat'));
    const before = (await metrics()).compatible.calls.length;
    const refused = await publicCall('nvidia-safety-not-chat', '/v1/chat/completions', { model: 'compatible-nvidia/fixture-safety', messages: [{ role: 'user', content: 'Do not substitute another model.' }] });
    assert.ok(refused.status >= 400, refused.text);
    assert.equal((await metrics()).compatible.calls.length, before, 'a safety-only model cannot be dispatched to the chat model'); row.upstreamCalls = 0;
  });
  result.pass = result.cases.length === targets.length + 1 && result.cases.every(row => row.pass); save('compatible-matrix.json', result);
  assert.equal(result.pass, true, result.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
