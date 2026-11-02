import assert from 'node:assert/strict';

export function createMultimodalFixture(metrics) {
  return async (req, res, path) => {
    const match = path.match(/^\/multimodal\/(chat|responses)\/v1\/(models|chat\/completions|responses)$/);
    if (!match) return false;
    const [, wire, operation] = match;
    const state = metrics.multimodal ??= { catalogs: {}, calls: [], rejected: 0 };
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer fixture-multimodal-key') { state.rejected++; res.writeHead(401); res.end('{"error":"controlled media credential required"}'); return true; }
    if (operation === 'models' && req.method === 'GET') {
      state.catalogs[wire] = (state.catalogs[wire] ?? 0) + 1;
      res.end(JSON.stringify({ data: [{ id: 'fixture-multimodal', supported_endpoints: [wire === 'chat' ? '/chat/completions' : '/responses'], capabilities: { supports: { vision: true } } }] })); return true;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const input = JSON.parse(raw); assert.equal(req.method, 'POST'); assert.equal(operation, wire === 'chat' ? 'chat/completions' : 'responses');
      assert.equal(input.model, 'fixture-multimodal');
      const messages = wire === 'chat' ? input.messages : input.input;
      assert.ok(Array.isArray(messages) && messages.length);
      const content = messages.find(item => item.role === 'user')?.content;
      assert.ok(Array.isArray(content) && content.length, 'the fixture must see actual ordered content parts');
      for (const part of content) assert.ok(['text', 'image_url', 'file', 'input_text', 'input_image', 'input_file'].includes(part.type), 'unsupported native part must not look successful');
      state.calls.push({ wire, operation, content }); metrics.inference++;
      if (wire === 'chat') res.end(JSON.stringify({ id: 'chat_multimodal_fixture', object: 'chat.completion', created: 1, model: input.model, choices: [{ index: 0, message: { role: 'assistant', content: 'multimodal-fixture-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
      else res.end(JSON.stringify({ id: 'resp_multimodal_fixture', object: 'response', created_at: 1, model: input.model, status: 'completed', output: [{ type: 'message', id: 'msg_multimodal_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'multimodal-fixture-ok', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }));
    } catch (error) {
      let input; try { input = JSON.parse(raw); } catch { /* the test already records the parse failure */ }
      state.lastRejected = { message: error.message, wire, operation, model: input?.model,
        partTypes: (wire === 'chat' ? input?.messages : input?.input)?.find(item => item.role === 'user')?.content?.map(part => part.type) };
      state.rejected++; res.writeHead(422); res.end('{"error":"controlled media carrier mismatch"}');
    }
    return true;
  };
}
