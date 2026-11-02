import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('multimodal peer refuses wrong credentials and malformed carrier before accepting an ordered native request', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/multimodal/chat/v1/`;
    const denied = await fetch(origin + 'models', { signal: AbortSignal.timeout(2000) }); assert.equal(denied.status, 401); await denied.text();
    const headers = { Authorization: 'Bearer fixture-multimodal-key', 'Content-Type': 'application/json' };
    const wrong = await fetch(origin + 'chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'wrong', messages: [{ role: 'user', content: [{ type: 'text', text: 'wrong' }] }] }), signal: AbortSignal.timeout(2000) }); assert.equal(wrong.status, 422); await wrong.text();
    assert.equal(metrics.multimodal.calls.length, 0);
    const good = await fetch(origin + 'chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'fixture-multimodal', messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }), signal: AbortSignal.timeout(2000) });
    assert.equal(good.status, 200); assert.equal((await good.json()).choices[0].message.content, 'multimodal-fixture-ok');
    assert.deepEqual(metrics.multimodal.calls[0].content.map(part => part.type), ['text', 'image_url']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
