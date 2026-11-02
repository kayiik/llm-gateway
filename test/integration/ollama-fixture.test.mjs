import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('Ollama daemon peer refuses wrong credentials and model before native chat', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/api/`;
    const wrongKey = await fetch(origin + 'tags', { headers: { Authorization: 'Bearer foreign-token' }, signal: AbortSignal.timeout(2000) }); assert.equal(wrongKey.status, 401); await wrongKey.text();
    const wrongModel = await fetch(origin + 'chat', { method: 'POST', body: JSON.stringify({ model: 'other', messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 16 } }), signal: AbortSignal.timeout(2000) }); assert.equal(wrongModel.status, 422); await wrongModel.text();
    assert.equal(metrics.ollama.rejected, 2); assert.equal(metrics.inference, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
