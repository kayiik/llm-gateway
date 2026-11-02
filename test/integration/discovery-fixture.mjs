import assert from 'node:assert/strict';

export function createDiscoveryFixture(metrics) {
  let released = false;
  const waiting = new Set();
  const state = metrics.discovery ??= { listed: 0, left: 0, completed: 0, inferred: 0, rejected: 0 };
  return async (req, res, path) => {
    if (!path.startsWith('/discovery/')) return false;
    if (path === '/discovery/control/release' && req.method === 'POST') {
      released = true; for (const wake of waiting) wake();
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ released: true })); return true;
    }
    if (path === '/discovery/control/hold' && req.method === 'POST') {
      released = false; res.setHeader('Content-Type', 'application/json'); res.end('{"holding":true}'); return true;
    }
    if (req.headers.authorization !== 'Bearer fixture-discovery-token') { state.rejected++; res.writeHead(401); res.end('{"error":"controlled catalog credential required"}'); return true; }
    if (path === '/discovery/v1/models' && req.method === 'GET') {
      state.listed++;
      let answered = false;
      res.on('close', () => { if (!answered) state.left++; });
      if (!released) await new Promise(resolve => {
        const wake = () => { waiting.delete(wake); resolve(); };
        waiting.add(wake);
        res.on('close', () => { if (!answered) wake(); });
      });
      if (res.destroyed) return true;
      answered = true; state.completed++;
      res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"fixture-discovery-model","supported_endpoints":["/chat/completions"]}]}'); return true;
    }
    if (path !== '/discovery/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return true; }
    let raw = ''; for await (const part of req) raw += part;
    try { const input = JSON.parse(raw); assert.equal(input.model, 'fixture-discovery-model'); assert.ok(input.messages?.length); }
    catch { state.rejected++; res.writeHead(422); res.end('{"error":"controlled inference mismatch"}'); return true; }
    state.inferred++; metrics.inference++;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"id":"chat_discovery_fixture","object":"chat.completion","created":1,"model":"fixture-discovery-model","choices":[{"index":0,"message":{"role":"assistant","content":"discovered-fixture"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}');
    return true;
  };
}
