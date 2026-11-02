import assert from 'node:assert/strict';

export function createCompatibleFixture(metrics) {
  return async (req, res, path) => {
    const match = path.match(/^\/compatible\/([a-z0-9-]+)\/v1\/(models|chat\/completions)$/);
    if (!match) return false;
    const [, target, operation] = match;
    const state = metrics.compatible ??= { catalogs: {}, calls: [], rejected: 0 };
    const expected = target.endsWith('-anon') ? undefined : 'Bearer fixture-compatible-key';
    if (req.headers.authorization !== expected) { state.rejected++; res.writeHead(401); res.end('{"error":"controlled compatible credential refused"}'); return true; }
    if (operation === 'models' && req.method === 'GET') {
      state.catalogs[target] = (state.catalogs[target] ?? 0) + 1;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-chat', supported_endpoints: ['/chat/completions'], supported_parameters: ['temperature', 'max_tokens', 'tools'] }, ...(target === 'nvidia' ? [{ id: 'fixture-safety', supported_endpoints: ['/moderations'] }] : [])] })); return true;
    }
    let raw = ''; for await (const part of req) raw += part;
    try { const body = JSON.parse(raw); assert.equal(req.method, 'POST'); assert.equal(operation, 'chat/completions'); assert.equal(body.model, 'fixture-chat'); assert.ok(body.messages?.length); assert.equal(body.messages.at(-1).content, 'Return the controlled answer.');
      state.calls.push({ target, model: body.model, stream: body.stream === true, authorized: Boolean(expected) }); metrics.inference++;
      if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'chat_compatible_fixture', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'compatible:' + target }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })); return true; }
      res.setHeader('Content-Type', 'text/event-stream');
      const frame = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chat_compatible_fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.end(frame({ role: 'assistant', content: 'compatible:' + target }) + frame({}, 'stop') + `data: ${JSON.stringify({ id: 'chat_compatible_fixture', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`); return true;
    } catch { state.rejected++; res.writeHead(422); res.end('{"error":"controlled compatible request mismatch"}'); return true; }
  };
}
