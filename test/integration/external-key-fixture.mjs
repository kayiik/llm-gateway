export function createExternalKeyFixture(metrics) {
  let mode = 'one';
  const state = metrics.externalKeys ??= { requests: [], denied: 0, responses: { one: 0, two: 0, unchanged: 0, invalid: 0, unavailable: 0 } };
  return async (req, res, path) => {
    if (!path.startsWith('/external-keys')) return false;
    if (path === '/external-keys/control' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const selected = JSON.parse(raw).mode;
      if (!['one', 'two', 'invalid', 'unavailable'].includes(selected)) { res.writeHead(400); res.end(); return true; }
      mode = selected; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ mode })); return true;
    }
    if (path !== '/external-keys' || req.method !== 'GET') { res.writeHead(404); res.end(); return true; }
    if (req.headers.authorization !== 'Bearer fixture-external-source-token') { state.denied++; res.writeHead(401); res.end('{"error":"controlled source token required"}'); return true; }
    state.requests.push({ etag: req.headers['if-none-match'] ?? '', mode });
    if (mode === 'unavailable') { state.responses.unavailable++; res.writeHead(503); res.end('{"error":"controlled snapshot source unavailable"}'); return true; }
    if (mode === 'invalid') { state.responses.invalid++; res.setHeader('ETag', '"invalid"'); res.end('{"version":1,"count":9,"keys":[]}'); return true; }
    const etag = '"' + mode + '"';
    if (req.headers['if-none-match'] === etag) { state.responses.unchanged++; res.writeHead(304); res.end(); return true; }
    state.responses[mode]++;
    res.setHeader('Content-Type', 'application/json'); res.setHeader('ETag', etag);
    res.end(JSON.stringify({ version: 1, count: 1, keys: [{ name: 'controlled-http-' + mode, project: 'preserved-project', key: 'fixture-external-http-' + mode,
      allowed_routes: ['preserved-route'], allowed_models: ['preserved-route'], allowed_providers: ['preserved-provider'] }] })); return true;
  };
}
