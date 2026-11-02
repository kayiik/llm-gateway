import assert from 'node:assert/strict';

export function createAzureFixture(metrics) {
  return async (req, res, path) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (!path.startsWith('/azure/') && !['azure-resource', 'azure-redirect', 'azure-untrusted'].includes(host)) return false;
    const state = metrics.azure ??= { catalogs: [], calls: [], rejected: 0, wrongCatalog: 0, foreignRequests: 0 };
    if (path.startsWith('/azure/foreign') || host === 'azure-untrusted') { state.foreignRequests++; res.writeHead(418); res.end(); return true; }
    const match = path.match(/^\/azure\/(resource|redirect)\/openai\/(deployments|v1\/models|v1\/chat\/completions)$/) ?? path.match(/^\/openai\/(deployments|v1\/models|v1\/chat\/completions)$/);
    if (!match) return false;
    const target = match.length === 3 ? match[1] : host.slice('azure-'.length), operation = match.at(-1), query = new URL(req.url, 'http://fixture.invalid').searchParams;
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['api-key'] !== 'fixture-azure-key' || req.headers.authorization) { state.rejected++; res.writeHead(401); res.end('{"error":"Azure fixture requires api-key without bearer"}'); return true; }
    if (operation === 'v1/models') { state.wrongCatalog++; res.writeHead(422); res.end('{"error":"untruthful generic model list is not used"}'); return true; }
    if (operation === 'deployments' && req.method === 'GET') {
      assert.equal(query.get('api-version'), '2023-03-15-preview');
      state.catalogs.push({ target, after: query.get('after') });
      if (target === 'redirect') { res.writeHead(302, { Location: 'http://azure-untrusted:18889/openai/deployments' }); res.end(); return true; }
      if (!query.get('after')) { res.end(JSON.stringify({ data: [{ id: 'fixture-deployment', model: 'gpt-4o', status: 'succeeded' }, { id: 'fixture-embedding', model: 'text-embedding-3-small', status: 'succeeded' }], has_more: true, last_id: 'page-1' })); return true; }
      assert.equal(query.get('after'), 'page-1'); res.end('{"data":[{"id":"fixture-backup","model":"gpt-4o","status":"succeeded"}],"has_more":false}'); return true;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const input = JSON.parse(raw); assert.equal(req.method, 'POST'); assert.equal(operation, 'v1/chat/completions');
      assert.ok(['fixture-deployment', 'fixture-backup'].includes(input.model)); assert.ok(input.messages?.length);
      state.calls.push({ target, model: input.model, stream: input.stream === true }); metrics.inference++;
      if (input.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ id: 'chat_azure_fixture', object: 'chat.completion.chunk', model: input.model + '-version', choices: [{ index: 0, delta: { role: 'assistant', content: 'azure-fixture-ok' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'chat_azure_fixture', object: 'chat.completion.chunk', model: input.model + '-version', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); return true; }
      res.end(JSON.stringify({ id: 'chat_azure_fixture', object: 'chat.completion', model: input.model + '-version', choices: [{ index: 0, message: { role: 'assistant', content: 'azure-fixture-ok' }, finish_reason: 'stop' }], prompt_filter_results: [{ content_filter_results: {} }], service_tier: 'fixture', usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4, latency_checkpoint: 1 } })); return true;
    } catch { state.rejected++; res.writeHead(422); res.end('{"error":"Azure fixture request mismatch"}'); return true; }
  };
}
