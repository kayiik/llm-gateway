import assert from 'node:assert/strict';
import http from 'node:http';

const aliases = {
  '/chat/completions': '/v1/chat/completions', '/responses': '/v1/responses', '/completions': '/v1/chat/completions',
  '/models': '/v1/models', '/messages': '/v1/messages', '/messages/count_tokens': '/v1/messages/count_tokens',
  '/audio/transcriptions': '/v1/audio/transcriptions', '/audio/speech': '/v1/audio/speech', '/realtime': '/v1/realtime',
  '/realtime/calls': '/v1/realtime/calls', '/embeddings': '/v1/embeddings', '/images/generations': '/v1/images/generations', '/videos/generations': '/v1/videos/generations',
};

export async function runHTTPBoundaryMatrix({ admin, request, publicCall, metrics, save }) {
  const evidence = { boundary: 'Installed HTTP aliases, native and estimated counts, headers, body framing and request limits', pass: false, cases: [] };
  const origin = process.env.REPLAY_ORIGIN, adminKey = process.env.REPLAY_ADMIN_KEY;
  const test = async (name, run) => {
    const row = { name, pass: false }; evidence.cases.push(row);
    try { await run(row); row.pass = true; } catch (error) { row.error = error.message; }
    finally { save('http-boundary-matrix.json', evidence); }
  };
  for (const target of ['native', 'later', 'denied', 'messages']) {
    await admin('providers', { id: 'boundary-' + target, registry_id: 'anthropic', base_url: `http://upstream:18889/boundary/${target}`, api_key: 'fixture-boundary-key' });
    await admin(`providers/boundary-${target}/refresh`, {});
  }
  await admin('providers', { id: 'boundary-compatible', registry_id: 'openrouter', base_url: 'http://upstream:18889/chat', api_key: 'fixture-boundary-key' });
  await admin('providers/boundary-compatible/refresh', {});
  for (const [name, targets] of [['boundary-count-native', ['boundary-native', 'boundary-later']], ['boundary-count-denied', ['boundary-denied', 'boundary-later']], ['boundary-count-estimate', ['boundary-compatible', 'boundary-native']]]) await admin('endpoints', { name, failover: targets.map(provider => ({ provider, model: 'fixture' })) });
  const project = await admin('projects', { slug: 'boundary-count', name: 'Boundary count' });
  const caller = await admin('keys', { project_id: project.id, name: 'Boundary count caller', daily_requests: 1 });
  const countBody = { model: 'boundary-count-native', messages: [{ role: 'user', content: 'count' }], system: [{ type: 'text', text: 'controlled system' }], tools: [{ name: 'lookup', input_schema: { type: 'object' } }] };
  const nativeCount = async (path, body = countBody) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + caller.token, 'Content-Type': 'application/json', 'Anthropic-Version': '2024-01-01', 'Anthropic-Beta': 'fixture-a,fixture-b', 'X-Arbitrary': 'must-not-forward' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, text: await response.text(), headers: Object.fromEntries(response.headers) };
  };
  await test('native-count-preserves-exact-integer-headers-and-single-target-retry', async row => {
    const before = await metrics();
    for (const path of ['/v1/messages/count_tokens', '/messages/count_tokens']) {
      const response = await nativeCount(path); assert.equal(response.status, 200, response.text);
      assert.equal(BigInt(response.text.match(/"input_tokens"\s*:\s*(\d+)/)?.[1]), 9007199254740993n);
      assert.notEqual(response.headers['x-llmgw-token-count'], 'estimate');
    }
    const after = await metrics();
    assert.equal(after.inference, before.inference);
    assert.equal(after.boundary.count.native - (before.boundary?.count?.native ?? 0), 4);
    assert.equal(after.boundary.count.later ?? 0, 0); row.nativeAttempts = 4;
  });
  await test('native-count-terminal-auth-error-does-not-fail-over', async row => {
    const before = await metrics();
    const response = await nativeCount('/v1/messages/count_tokens', { ...countBody, model: 'boundary-count-denied' });
    assert.equal(response.status, 401, response.text); assert.equal(JSON.parse(response.text).type, 'error');
    const after = await metrics(); assert.equal(after.inference, before.inference);
    assert.equal(after.boundary.count.denied - (before.boundary?.count?.denied ?? 0), 1); assert.equal(after.boundary.count.later ?? 0, 0); row.upstreamAttempts = 1;
  });
  await test('estimated-count-is-marked-repeatable-and-never-infers', async row => {
    const before = await metrics(); const counts = [];
    for (const text of ['a', 'a', 'a'.repeat(80)]) {
      const response = await request('/v1/messages/count_tokens', { model: 'boundary-count-estimate', messages: [{ role: 'user', content: text }] }, caller.token);
      assert.equal(response.status, 200, response.text); assert.equal(response.headers['x-llmgw-token-count'], 'estimate');
      const count = JSON.parse(response.text).input_tokens; assert.ok(Number.isInteger(count) && count > 0 && count < 1024); counts.push(count);
    }
    assert.equal(counts[0], counts[1]); assert.ok(counts[2] > counts[0]);
    const after = await metrics(); assert.equal(after.inference, before.inference); assert.deepEqual(after.boundary.count, before.boundary.count); row.counts = counts;
  });
  await test('count-policy-checks-without-quota-or-usage-consumption', async row => {
    const limits = (await admin(`keys/${caller.key.id}/limits`)).limits;
    for (const value of limits.filter(item => item.field === 'daily_requests')) assert.equal(value.used, 0, 'count calls must leave inference request quota untouched');
    const logs = await admin('requests?key_id=' + caller.key.id);
    assert.equal((logs.requests ?? logs.rows ?? logs).length, 0, 'counting must not fabricate inference usage');
    const restricted = await admin('keys', { project_id: project.id, name: 'Boundary count restricted', allowed_models: ['boundary-compatible/not-permitted'] });
    const before = await metrics();
    const denied = await request('/v1/messages/count_tokens', { model: 'boundary-compatible/fixture', messages: [] }, restricted.token);
    assert.equal(denied.status, 403, denied.text); assert.equal((await metrics()).inference, before.inference); row.usedRequests = 0;
  });
  for (const [alias, canonical] of Object.entries(aliases)) await test('bare-alias-' + alias, async row => {
    const get = ['/models', '/realtime'].includes(alias);
    const before = (await metrics()).inference;
    const first = await request(canonical, get ? undefined : {});
    const second = await request(alias, get ? undefined : {});
    assert.equal(second.status, first.status, second.text); assert.match(second.contentType, /application\/json/);
    if (alias === '/models') assert.deepEqual(JSON.parse(second.text), JSON.parse(first.text));
    else { assert.ok(first.status >= 400 && JSON.parse(first.text).error, 'canonical route must answer its own structured validation'); assert.equal(JSON.parse(second.text).error.type, JSON.parse(first.text).error.type); }
    assert.equal((await metrics()).inference, before); row.canonical = canonical; row.status = second.status;
  });
  await test('json-framing-rejects-malformed-and-trailing-content-before-dispatch', async row => {
    const before = (await metrics()).inference;
    for (const path of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) for (const text of ['{', JSON.stringify({ model: 'boundary-compatible/fixture', messages: [{ role: 'user', content: 'hello' }], input: 'hello', max_tokens: 17 }) + '{}']) {
      const response = await fetch(origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' }, body: text, signal: AbortSignal.timeout(5000) });
      const body = await response.json(); assert.ok([400, 422].includes(response.status)); assert.ok(body.error); if (path.endsWith('/messages')) assert.equal(body.type, 'error');
    }
    assert.equal((await metrics()).inference, before); row.refusals = 6;
  });
  await test('security-headers-protect-api-errors-administration-and-console', async row => {
    for (const [path, body, token] of [['/admin/api/state', undefined, adminKey], ['/admin/api/state', undefined, ''], ['/v1/chat/completions', {}, adminKey], ['/v1/messages', {}, adminKey], ['/console/', undefined, '']]) {
      const response = await request(path, body, token);
      assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['referrer-policy'], 'same-origin');
      if (path.startsWith('/admin/')) assert.equal(response.headers['cache-control'], 'no-store');
      if (path === '/console/') { assert.equal(response.headers['x-frame-options'], 'DENY'); assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/); }
    }
    row.responseClasses = 5;
  });
  const oversized = async (path, chunked) => new Promise((resolve, reject) => {
    let stopped = false, sentBytes = 0;
    const headers = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json', ...(chunked ? {} : { 'Content-Length': String((64 << 20) + 1) }) };
    const req = http.request(new URL(path, origin), { method: 'POST', headers }, res => {
      stopped = true; let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => { resolve({ status: res.statusCode, text, sentBytes }); req.destroy(); }); res.on('error', reject);
    });
    req.on('error', error => { if (!stopped) reject(error); }); req.setTimeout(15000, () => req.destroy(new Error('body-limit deadline')));
    if (!chunked) { req.end('{}'); return; }
    req.write('{"model":"boundary-count-native","messages":[{"role":"user","content":"');
    const chunk = Buffer.alloc(64 << 10, 'a'); let remaining = (32 << 20) + chunk.length;
    const pump = () => {
      while (!stopped && remaining > 0) { remaining -= chunk.length; sentBytes += chunk.length; if (!req.write(chunk)) { req.once('drain', pump); return; } }
      if (!stopped) req.end('"}]}');
    };
    pump();
  });
  await test('announced-body-limit-preserves-protocol-error-envelopes', async row => {
    const before = (await metrics()).inference;
    for (const path of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
      const response = await oversized(path, false); assert.equal(response.status, 413, response.text);
      const body = JSON.parse(response.text); assert.ok(body.error); if (path.endsWith('/messages')) assert.equal(body.type, 'error');
    }
    assert.equal((await metrics()).inference, before); row.refusals = 3;
  });
  await test('chunked-native-count-body-is-bounded-before-provider-io', async row => {
    const before = await metrics(); const response = await oversized('/v1/messages/count_tokens', true);
    assert.equal(response.status, 413, response.text); assert.equal(JSON.parse(response.text).type, 'error');
    const after = await metrics(); assert.equal(after.inference, before.inference); assert.deepEqual(after.boundary.count, before.boundary.count);
    row.sentBytes = response.sentBytes;
  });
  await test('header-budget-overrides-body-and-gateway-controls-never-reach-native-messages', async row => {
    const body = { model: 'boundary-messages/fixture', messages: [{ role: 'user', content: 'boundary' }], max_tokens: 17, temperature: 0.125, stream: true, fallback_timeout_ms: 40, affinity_key: 'body-affinity' };
    for (const [header, budget, success] of [['1000', 40, true], ['40', 1000, false], [null, 'invalid', true]]) {
      const response = await fetch(origin + '/v1/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json', ...(header ? { 'X-LLMGW-Fallback-Timeout-Ms': header, 'X-LLMGW-Affinity-Key': 'header-affinity' } : {}) }, body: JSON.stringify({ ...body, fallback_timeout_ms: budget }), signal: AbortSignal.timeout(5000) });
      const text = await response.text();
      if (success) { assert.equal(response.status, 200, text); assert.match(text, /message_stop/); assert.match(text, /native boundary/); }
      else { assert.ok(response.status >= 400, text); assert.equal(JSON.parse(text).type, 'error'); }
    }
    assert.equal((await metrics()).boundary.rejected, 0, 'native wire/header contract must reject any leaked Gateway controls'); row.headerPrecedence = true;
  });
  evidence.pass = evidence.cases.length === 22 && evidence.cases.every(row => row.pass);
  save('http-boundary-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
