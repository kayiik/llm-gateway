import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createFakeUpstream } from './fake-upstream.mjs';

async function fixture(run) {
  const { server, metrics } = createFakeUpstream();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, metrics); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('native count fixture validates actual protocol headers and preserves an exact large integer', async () => {
  await fixture(async (origin, metrics) => {
    const body = { model: 'fixture', messages: [{ role: 'user', content: 'count' }], system: [{ type: 'text', text: 'controlled system' }], tools: [{ name: 'lookup' }] };
    const send = headers => fetch(origin + '/boundary/native/v1/messages/count_tokens', { method: 'POST', headers: { 'x-api-key': 'fixture-boundary-key', 'anthropic-version': '2024-01-01', 'anthropic-beta': 'fixture-a,fixture-b', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
    const retry = await send(); assert.equal(retry.status, 503); await retry.text();
    const response = await send(); assert.equal(response.status, 200); assert.match(await response.text(), /9007199254740993/);
    const wrong = await send({ 'x-arbitrary': 'must-not-forward' }); assert.equal(wrong.status, 422); await wrong.text();
    assert.equal(metrics.boundary.rejected, 1); assert.equal(metrics.inference, 0);
  });
});

test('native Messages fixture refuses leaked gateway body and header controls', async () => {
  await fixture(async origin => {
    const body = { model: 'fixture', messages: [{ role: 'user', content: 'boundary' }], max_tokens: 17, temperature: 0.125 };
    for (const [extra, headers] of [[{ fallback_timeout_ms: 40 }, {}], [{}, { 'X-LLMGW-Affinity-Key': 'leaked' }]]) {
      const response = await fetch(origin + '/boundary/messages/v1/messages', { method: 'POST', headers: { 'x-api-key': 'fixture-boundary-key', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ...body, ...extra }), signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 422); await response.text();
    }
  });
});
