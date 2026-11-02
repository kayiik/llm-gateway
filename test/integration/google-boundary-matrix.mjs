import assert from 'node:assert/strict';

export async function runGoogleBoundaryMatrix({ admin, request, publicCall, metrics, save, registerSecret }) {
  registerSecret('fixture-google-native-key'); registerSecret('fixture-google-compatible-key');
  const result = { boundary: 'Installed native AI Studio/Vertex declaration and Google-compatible configured-path distinction against strict synthetic peers; no real Google account', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('google-boundary-matrix.json', result); } };
  const chat = (model, stream = false) => ({ model, messages: [{ role: 'user', content: 'Give the controlled answer.' }], max_tokens: 16, ...(stream ? { stream } : {}) });
  await test('google-compatible-configured-path-bearer-and-native-chat-json-sse', async row => {
    await admin('providers', { id: 'google-compatible-fixture', registry_id: 'custom_openai', base_url: 'http://upstream:18889/google-boundary/compatible/v1beta/openai', api_key: 'fixture-google-compatible-key' });
    await admin('providers/google-compatible-fixture/refresh', {});
    const before = (await metrics()).googleBoundary?.calls?.length ?? 0;
    const model = 'google-compatible-fixture/gemini-compatible';
    for (const stream of [false, true]) {
      const answer = await publicCall('google-compatible-' + (stream ? 'sse' : 'json'), '/v1/chat/completions', chat(model, stream));
      assert.equal(answer.status, 200, answer.text);
      if (stream) assert.match(answer.text, /compatible-fixture-ok.*[\s\S]*data: \[DONE\]/);
      else assert.equal(JSON.parse(answer.text).choices[0].message.content, 'compatible-fixture-ok');
    }
    const actual = (await metrics()).googleBoundary;
    assert.deepEqual(actual.calls.slice(before), [{ type: 'compatible', model: 'gemini-compatible', stream: false }, { type: 'compatible', model: 'gemini-compatible', stream: true }]);
    assert.equal(actual.rejected, 0); assert.equal(actual.wrongWire, 0); row.calls = 2;
  });
  await test('ai-studio-two-page-catalog-keeps-native-declarations-distinct', async row => {
    await admin('providers', { id: 'google-studio-fixture', registry_id: 'ai_studio', base_url: 'http://upstream:18889/google-boundary/studio/v1beta', api_key: 'fixture-google-native-key' });
    const before = (await metrics()).googleBoundary?.catalogs?.length ?? 0;
    await admin('providers/google-studio-fixture/refresh', {});
    const listed = await request('/v1/models'); assert.equal(listed.status, 200, listed.text);
    const rows = JSON.parse(listed.text).data.filter(item => item.id.startsWith('google-studio-fixture/'));
    assert.ok(rows.some(item => item.id === 'google-studio-fixture/gemini-native'));
    assert.ok(rows.some(item => item.id === 'google-studio-fixture/gemini-second'));
    const embedding = rows.find(item => item.id === 'google-studio-fixture/gemini-embedding');
    assert.ok(embedding, 'an embedding-only model remains discoverable on its own declared operation');
    assert.notEqual(embedding.capabilities?.chat, true, 'embedding-only method cannot declare Chat');
    assert.ok(!embedding.native_surfaces?.includes('/v1/chat/completions'), 'an embedding must not be advertised as native Chat');
    const catalog = (await metrics()).googleBoundary.catalogs.slice(before);
    assert.deepEqual(catalog, [{ type: 'studio', token: null }, { type: 'studio', token: 'page +/&=' }]); row.pages = 2;
  });
  await test('ai-studio-chat-denies-implicit-conversion-and-explicitly-allows-native-json-sse', async row => {
    const model = 'google-studio-fixture/gemini-native', before = (await metrics()).googleBoundary.calls.length;
    const denied = await publicCall('google-studio-denied', '/v1/chat/completions', chat(model)); assert.equal(denied.status, 400, denied.text);
    assert.match(denied.text, /adaptation_required/); assert.equal((await metrics()).googleBoundary.calls.length, before);
    for (const stream of [false, true]) {
      const answer = await publicCall('google-studio-' + (stream ? 'sse' : 'json'), '/v1/chat/completions', chat(model, stream), undefined, 'allow');
      assert.equal(answer.status, 200, answer.text); assert.match(answer.text, /native-fixture-ok/);
      if (!stream) assert.deepEqual(JSON.parse(answer.text).usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
      else assert.match(answer.text, /data: \[DONE\]/);
    }
    const actual = (await metrics()).googleBoundary;
    assert.deepEqual(actual.calls.slice(before), [{ type: 'studio', model: 'gemini-native', stream: false }, { type: 'studio', model: 'gemini-native', stream: true }]); row.calls = 2;
  });
  await test('ai-studio-messages-denies-implicit-conversion-before-source-io', async row => {
    const before = (await metrics()).googleBoundary.calls.length;
    const input = { model: 'google-studio-fixture/gemini-native', max_tokens: 16, messages: [{ role: 'user', content: 'test' }] };
    const denied = await publicCall('google-studio-messages-denied', '/v1/messages', input);
    assert.equal(denied.status, 400, denied.text); assert.match(denied.text, /adaptation_required/);
    assert.equal((await metrics()).googleBoundary.calls.length, before); row.calls = 0;
  });
  await test('ai-studio-catalog-rejected-key-does-not-publish-a-model-or-leak-a-key', async row => {
    await admin('providers', { id: 'google-studio-rejected', registry_id: 'ai_studio', base_url: 'http://upstream:18889/google-boundary/rejected/v1beta', api_key: 'fixture-google-native-key' });
    const before = (await metrics()).googleBoundary.calls.length;
    const refreshed = await request('/admin/api/providers/google-studio-rejected/refresh', {});
    const listed = await request('/v1/models'); assert.equal(listed.status, 200, listed.text);
    assert.ok(!JSON.parse(listed.text).data.some(item => item.id.startsWith('google-studio-rejected/')));
    assert.equal((await metrics()).googleBoundary.calls.length, before);
    assert.ok(!refreshed.text.includes('fixture-google-native-key')); row.refreshStatus = refreshed.status;
  });
  await test('vertex-api-key-cannot-fabricate-an-oauth-publisher-catalog', async row => {
    await admin('providers', { id: 'google-vertex-key-only', registry_id: 'vertex_ai', base_url: 'http://upstream:18889/google-boundary/vertex/v1', project: 'fixture-project', location: 'global', api_key: 'fixture-google-native-key' });
    const before = (await metrics()).googleBoundary;
    const refreshed = await request('/admin/api/providers/google-vertex-key-only/refresh', {});
    assert.ok(!refreshed.text.includes('fixture-google-native-key'));
    const listed = await request('/v1/models'); assert.equal(listed.status, 200, listed.text);
    assert.ok(!JSON.parse(listed.text).data.some(item => item.id.startsWith('google-vertex-key-only/')));
    const after = (await metrics()).googleBoundary;
    assert.equal(after.calls.length, before.calls.length); assert.ok(!after.catalogs.some(item => item.type === 'vertex-api-key'), 'catalog must fail before an API-key request to OAuth-only publisher listing');
    row.refreshStatus = refreshed.status;
  });
  result.pass = result.cases.length === 6 && result.cases.every(row => row.pass); save('google-boundary-matrix.json', result);
  assert.equal(result.pass, true, result.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
