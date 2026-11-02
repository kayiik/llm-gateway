import assert from 'node:assert/strict';

export function createGoogleBoundaryFixture(metrics) {
  return async (req, res, path) => {
    if (!path.startsWith('/google-boundary/')) return false;
    const state = metrics.googleBoundary ??= { catalogs: [], calls: [], rejected: 0, wrongWire: 0 };
    const url = new URL(req.url, 'http://fixture.invalid');
    const compatible = path.startsWith('/google-boundary/compatible/v1beta/openai/');
    const studio = path.startsWith('/google-boundary/studio/v1beta/');
    const rejected = path.startsWith('/google-boundary/rejected/v1beta/');
    const vertex = path.startsWith('/google-boundary/vertex/');
    if (!compatible && !studio && !rejected && !vertex) return false;
    const auth = compatible ? req.headers.authorization === 'Bearer fixture-google-compatible-key' && !req.headers['x-goog-api-key']
      : req.headers['x-goog-api-key'] === 'fixture-google-native-key' && !req.headers.authorization;
    if (!auth || url.searchParams.has('key')) { state.rejected++; res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"synthetic Google credential rejected"}}'); return true; }
    res.setHeader('Content-Type', 'application/json');
    if (rejected && path.endsWith('/models')) { state.catalogs.push({ type: 'studio-rejected' }); res.writeHead(401); res.end('{"error":{"message":"synthetic catalog credential rejected"}}'); return true; }
    if (compatible && path.endsWith('/models') && req.method === 'GET') {
      state.catalogs.push({ type: 'compatible' }); res.end('{"data":[{"id":"gemini-compatible","supported_endpoints":["/chat/completions"]}]}'); return true;
    }
    if (studio && path.endsWith('/models') && req.method === 'GET') {
      assert.equal(url.searchParams.get('pageSize'), '1000'); const token = url.searchParams.get('pageToken'); state.catalogs.push({ type: 'studio', token });
      if (!token) { res.end(JSON.stringify({ models: [{ name: 'models/gemini-native', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page +/&=' })); return true; }
      assert.equal(token, 'page +/&='); res.end('{"models":[{"name":"models/gemini-second","supportedGenerationMethods":["generateContent"]}],"nextPageToken":""}'); return true;
    }
    if (vertex && path.endsWith('/models') && req.method === 'GET') {
      state.catalogs.push({ type: 'vertex-api-key' }); res.writeHead(401); res.end('{"error":{"message":"publisher listing needs service account OAuth, not an API key"}}'); return true;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const input = JSON.parse(raw); assert.equal(req.method, 'POST');
      if (compatible) {
        assert.ok(path.endsWith('/chat/completions')); assert.equal(input.model, 'gemini-compatible'); assert.ok(input.messages?.length);
        state.calls.push({ type: 'compatible', model: input.model, stream: input.stream === true }); metrics.inference++;
        if (input.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ id: 'google-compatible-fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta: { content: 'compatible-fixture-ok' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`); return true; }
        res.end(JSON.stringify({ id: 'google-compatible-fixture', object: 'chat.completion', model: input.model, choices: [{ index: 0, message: { role: 'assistant', content: 'compatible-fixture-ok' }, finish_reason: 'stop' }] })); return true;
      }
      assert.ok(path.endsWith(':generateContent') || path.endsWith(':streamGenerateContent'));
      const model = path.match(/\/models\/([^/:]+):(?:streamG|g)enerateContent$/)?.[1]; assert.ok(['gemini-native', 'gemini-second'].includes(model));
      assert.equal(input.contents?.[0]?.role, 'user'); assert.ok(input.contents?.[0]?.parts?.[0]?.text);
      const type = vertex ? 'vertex' : 'studio', stream = path.endsWith(':streamGenerateContent');
      if (vertex) { assert.match(path, /\/v1\/projects\/fixture-project\/locations\/global\/publishers\/google\/models\//); }
      else assert.equal(url.searchParams.get('alt'), stream ? 'sse' : null);
      state.calls.push({ type, model, stream }); metrics.inference++;
      const response = { candidates: [{ content: { role: 'model', parts: [{ text: 'native-fixture-ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } };
      if (stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify(response) + '\n\n'); }
      else res.end(JSON.stringify(response));
    } catch { state.wrongWire++; res.writeHead(422); res.end('{"error":{"message":"synthetic Google request did not match the declared native or compatible wire"}}'); }
    return true;
  };
}
