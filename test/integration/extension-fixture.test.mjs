import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createFakeUpstream } from './fake-upstream.mjs';

test('controlled daemon authenticates its shared secret and rejects a mismatched native model surface', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/daemon/extension/v1/`;
    const denied = await fetch(origin + 'info', { headers: { Authorization: 'Bearer wrong-fixture-secret' }, signal: AbortSignal.timeout(2000) }); assert.equal(denied.status, 401); assert.ok(!(await denied.text()).includes('wrong-fixture-secret'));
    const headers = { Authorization: 'Bearer fixture-extension-secret' };
    const catalog = await (await fetch(origin + 'fixture_declared/models', { headers, signal: AbortSignal.timeout(2000) })).json();
    assert.deepEqual(catalog.models.find(item => item.id === 'chat-only').supported_apis, ['/v1/chat/completions']);
    const unknown = catalog.models.find(item => item.id === 'unknown-model'); assert.equal(unknown.capabilities.operations.chat, 'unknown'); assert.equal(unknown.supported_apis, undefined);
    const wrong = await fetch(origin + 'fixture_declared/invoke', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Surface': 'responses', 'X-Model': 'chat-only' }, body: JSON.stringify({ model: 'chat-only', input: 'wrong wire' }), signal: AbortSignal.timeout(2000) }); assert.equal(wrong.status, 422); await wrong.text();
    assert.equal(metrics.extension.rejected, 1); assert.equal(metrics.inference, 1, 'a rejected native request is still actual daemon I/O');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
