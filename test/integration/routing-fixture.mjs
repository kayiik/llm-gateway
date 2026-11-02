import assert from 'node:assert/strict';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const credentials = new Map([
  ['Bearer fixture-routing-token', 'system'],
  ['Bearer fixture-routing-human-a', 'human-a'],
  ['Bearer fixture-routing-human-b', 'human-b'],
]);

export function createRoutingFixture(metrics) {
  return async (req, res, path) => {
    const match = path.match(/^\/routing\/([a-z0-9-]+)\/v1\/(models|chat\/completions|control)$/);
    if (!match) return false;
    const target = match[1];
    const state = metrics.routing ??= { calls: [], cancelled: {}, rejected: 0, discovery: {} };
    const ids = target === 'healthy' ? ['fixture', 'routing-unique', 'vendor/native-model', 'shared-routing-alias'] : target === 'other' ? ['fixture', 'shared-routing-alias'] : ['fixture'];
    res.setHeader('Content-Type', 'application/json');
    if (match[2] === 'control' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const mode = JSON.parse(raw).mode;
      assert.ok(['chat', 'embedding', 'unknown'].includes(mode));
      (state.catalogs ??= {})[target] = mode;
      res.end(JSON.stringify({ mode })); return true;
    }
    if (match[2] === 'models' && req.method === 'GET') {
      state.discovery[target] = (state.discovery[target] ?? 0) + 1;
      const mode = state.catalogs?.[target] ?? (target === 'unknown-catalog' ? 'unknown' : 'chat');
      res.end(JSON.stringify({ data: ids.map(id => ({ id, ...(mode === 'unknown' ? {} : { supported_endpoints: [mode === 'embedding' ? '/embeddings' : '/chat/completions'] }) })) }));
      return true;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    metrics.inference++;
    let input;
    try {
      input = JSON.parse(raw);
      assert.equal(req.method, 'POST');
      assert.ok(credentials.has(req.headers.authorization), 'declared synthetic credential required');
      assert.ok(Array.isArray(input.messages) && input.messages.length, 'conversation required');
      assert.ok(ids.includes(input.model), 'a declared selected model is required');
      assert.equal(input.temperature, 0.125);
      assert.equal(input.max_tokens, 17);
      for (const key of ['fallback_timeout_ms', 'affinity_key', '_fallback_timeout_ms', '_affinity_key']) assert.equal(input[key], undefined, 'Gateway controls must not reach the provider');
      assert.equal(req.headers['x-llmgw-compatibility'], undefined);
    } catch {
      state.rejected++; res.writeHead(422); res.end('{"error":{"message":"Routing fixture request mismatch."}}'); return true;
    }
    const action = input.messages.at(-1)?.content;
    state.calls.push({ target, model: input.model, stream: input.stream === true, credential: credentials.get(req.headers.authorization), caller: input.user });
    let complete = false;
    res.on('close', () => { if (!complete) state.cancelled[target] = (state.cancelled[target] ?? 0) + 1; });
    const fail = (status, code, message, headers = {}) => {
      complete = true; res.writeHead(status, headers); res.end(JSON.stringify({ error: { type: code, code, message } }));
    };
    if (action !== 'routing:success') {
      if (target.startsWith('credit')) { fail(402, 'insufficient_quota', 'Controlled credit balance exhausted.'); return true; }
      if (target.startsWith('shape')) { fail(400, 'context_length_exceeded', 'The controlled request exceeds this model context.'); return true; }
      if (target.startsWith('long-retry')) { fail(429, 'rate_limit_exceeded', 'Controlled temporary rate limit.', { 'Retry-After': '3600' }); return true; }
      if (target.startsWith('transient') || target === 'circuit') { fail(503, 'overloaded_error', 'Controlled transient overload.'); return true; }
    }
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'routing-fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (target.startsWith('slow')) {
      await delay(200);
      if (res.destroyed) return true;
      if (target === 'slow-fail') { fail(503, 'overloaded_error', 'Controlled slow failure.'); return true; }
    }
    const content = `served:${target}:${input.model}`;
    const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    if (input.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(chunk({ role: 'assistant' }));
      if (target === 'opened-broken') { await delay(20); res.destroy(); return true; }
      if (target === 'opened-slow' || target === 'cancel-stream') { await delay(target === 'cancel-stream' ? 1000 : 200); if (res.destroyed) return true; }
      res.write(chunk({ content })); res.write(chunk({}, 'stop'));
      res.write(`data: ${JSON.stringify({ id: 'routing-fixture', object: 'chat.completion.chunk', model: input.model, choices: [], usage })}\n\n`);
      complete = true; res.end('data: [DONE]\n\n'); return true;
    }
    complete = true;
    res.end(JSON.stringify({ id: 'routing-fixture', object: 'chat.completion', model: input.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }));
    return true;
  };
}
