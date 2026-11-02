import assert from 'node:assert/strict';

export function createProtocolFixture(metrics) {
  return async (req, res, path) => {
    const match = path.match(/^\/boundary\/(native|later|denied|messages)\/v1\/(models|messages\/count_tokens|messages)$/);
    if (!match) return false;
    const target = match[1];
    const state = metrics.boundary ??= { count: {}, inference: {}, rejected: 0, cancelled: 0 };
    res.setHeader('Content-Type', 'application/json');
    if (match[2] === 'models') { res.end('{"data":[{"id":"fixture","supported_endpoints":["/messages"]}]}'); return true; }
    let raw = ''; for await (const part of req) raw += part;
    const counting = match[2] === 'messages/count_tokens';
    const counts = counting ? state.count : state.inference;
    counts[target] = (counts[target] ?? 0) + 1;
    if (!counting) metrics.inference++;
    let body;
    try {
      body = JSON.parse(raw);
      assert.equal(req.headers['x-api-key'], 'fixture-boundary-key');
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers['x-arbitrary'], undefined);
      assert.equal(body.model, 'fixture');
      for (const field of ['fallback_timeout_ms', 'affinity_key', '_fallback_timeout_ms', '_affinity_key']) assert.equal(body[field], undefined);
      assert.equal(req.headers['x-llmgw-fallback-timeout-ms'], undefined);
      assert.equal(req.headers['x-llmgw-affinity-key'], undefined);
      if (counting && target !== 'denied') {
        assert.equal(req.headers['anthropic-version'], '2024-01-01');
        assert.deepEqual(req.headers['anthropic-beta'].split(/,\s*/), ['fixture-a', 'fixture-b']);
        assert.deepEqual(body.messages, [{ role: 'user', content: 'count' }]);
        assert.deepEqual(body.system, [{ type: 'text', text: 'controlled system' }]);
        assert.equal(body.tools?.[0]?.name, 'lookup');
      }
    } catch {
      state.rejected++; res.writeHead(422); res.end('{"error":{"type":"invalid_request_error","message":"Controlled native protocol mismatch."}}'); return true;
    }
    if (counting) {
      if (target === 'denied') { res.writeHead(401); res.end('{"type":"error","error":{"type":"authentication_error","message":"Controlled credential rejection."}}'); return true; }
      if (counts[target] % 2 === 1) { res.writeHead(503); res.end('{"type":"error","error":{"type":"overloaded_error","message":"Controlled temporary overload."}}'); return true; }
      res.end('{"input_tokens":9007199254740993}'); return true;
    }
    let complete = false;
    res.on('close', () => { if (!complete) state.cancelled++; });
    await new Promise(resolve => setTimeout(resolve, 200));
    if (res.destroyed) return true;
    assert.equal(body.max_tokens, 17); assert.equal(body.temperature, 0.125);
    const message = { id: 'boundary-message', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'native boundary' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } };
    if (!body.stream) { complete = true; res.end(JSON.stringify(message)); return true; }
    res.setHeader('Content-Type', 'text/event-stream');
    const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
    complete = true;
    res.end(event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } }) + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'native boundary' } }) + event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }) + event('message_stop', {}));
    return true;
  };
}
