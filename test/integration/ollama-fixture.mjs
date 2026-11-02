import assert from 'node:assert/strict';

export function createOllamaFixture(metrics) {
  return async (req, res, path) => {
    if (path !== '/api/tags' && path !== '/api/chat') return false;
    const state = metrics.ollama ??= { catalogs: 0, calls: [], rejected: 0 };
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization || req.headers['api-key']) { state.rejected++; res.writeHead(401); res.end('{"error":"local daemon must be configured without a borrowed credential"}'); return true; }
    if (path === '/api/tags' && req.method === 'GET') { state.catalogs++; res.end('{"models":[{"name":"fixture-ollama:latest","model":"fixture-ollama:latest"},{"name":"qwen2.5:0.5b","model":"qwen2.5:0.5b"}]}'); return true; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      assert.equal(req.method, 'POST'); assert.equal(path, '/api/chat');
      const input = JSON.parse(raw);
      if (input.model === 'qwen2.5:0.5b' && metrics.realWireOllamaReply) {
        assert.ok(Array.isArray(input.messages) && input.messages.length);
        metrics.inference++;
        metrics.realWire?.served.push({ family: 'ollama', operation: 'chat', status: 200 });
        res.end(JSON.stringify(metrics.realWireOllamaReply));
        return true;
      }
      assert.equal(input.model, 'fixture-ollama:latest');
      assert.ok(Array.isArray(input.messages) && input.messages.length);
      assert.equal(input.options?.num_predict, 16);
      const tools = Boolean(input.tools?.length), stream = input.stream === true;
      state.calls.push({ model: input.model, stream, tools, roles: input.messages.map(item => item.role) }); metrics.inference++;
      const message = tools ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add', arguments: { a: 2 } } }] } : { role: 'assistant', content: 'ollama-fixture-ok' };
      if (stream) { res.setHeader('Content-Type', 'application/x-ndjson'); res.end(JSON.stringify({ message, done: false }) + '\n' + JSON.stringify({ done: true, prompt_eval_count: 7, eval_count: 3 }) + '\n'); }
      else res.end(JSON.stringify({ message, done: true, prompt_eval_count: 7, eval_count: 3 }));
    } catch { state.rejected++; res.writeHead(422); res.end('{"error":"Ollama fixture request mismatch"}'); }
    return true;
  };
}
