import assert from 'node:assert/strict';

export function createShutdownFixture(metrics) {
  const waiting = new Set();
  const state = metrics.shutdown ??= { starts: 0, completed: 0, cancelled: 0, released: 0 };
  return async (req, res, path) => {
    if (!path.startsWith('/shutdown/')) return false;
    if (path === '/shutdown/control/release' && req.method === 'POST') {
      const count = waiting.size; for (const release of waiting) release();
      state.released += count; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ released: count })); return true;
    }
    if (req.headers.authorization !== 'Bearer fixture-shutdown-token') { res.writeHead(401); res.end('{"error":"controlled shutdown credential required"}'); return true; }
    if (path === '/shutdown/v1/models' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"fixture","supported_endpoints":["/chat/completions"]}]}'); return true;
    }
    if (path !== '/shutdown/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return true; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const input = JSON.parse(raw); assert.equal(input.model, 'fixture'); assert.equal(input.stream, true);
      assert.equal(input.messages?.at(-1)?.content, 'hold until released');
    } catch { res.writeHead(422); res.end('{"error":"controlled shutdown request mismatch"}'); return true; }
    state.starts++; metrics.inference++;
    let complete = false;
    res.on('close', () => { if (!complete) state.cancelled++; });
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"id":"shutdown-fixture","object":"chat.completion.chunk","model":"fixture","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
    await new Promise(resolve => { const release = () => { waiting.delete(release); resolve(); }; waiting.add(release); });
    if (res.destroyed) return true;
    res.write('data: {"id":"shutdown-fixture","object":"chat.completion.chunk","model":"fixture","choices":[{"index":0,"delta":{"content":"drained-fixture"},"finish_reason":"stop"}]}\n\n');
    res.write('data: {"id":"shutdown-fixture","object":"chat.completion.chunk","model":"fixture","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n');
    complete = true; state.completed++; res.end('data: [DONE]\n\n'); return true;
  };
}
