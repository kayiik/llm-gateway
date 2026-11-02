import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createFakeUpstream } from './fake-upstream.mjs';

test('routing fixture rejects changed native controls, models and leaked gateway controls', async () => {
  const { server, metrics } = createFakeUpstream();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/routing/healthy/v1/chat/completions`;
    const original = { model: 'fixture', messages: [{ role: 'user', content: 'routing:fail' }], temperature: 0.125, max_tokens: 17 };
    for (const changed of [{ temperature: 0.5 }, { max_tokens: 20 }, { model: 'another-model' }, { affinity_key: 'leaked' }, { fallback_timeout_ms: 40 }]) {
      const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-routing-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...original, ...changed }), signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 422); await response.text();
    }
    assert.equal(metrics.inference, 5, 'even rejected requests are actual provider I/O');
    assert.equal(metrics.routing.calls.length, 0);
    assert.equal(metrics.routing.rejected, 5);
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-routing-token', 'Content-Type': 'application/json' }, body: JSON.stringify(original), signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'served:healthy:fixture');
    assert.equal(metrics.routing.calls.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
