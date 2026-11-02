import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('controlled client fixture rejects wrong credentials and model without inventing a successful native reply', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/clients/openai/v1/`;
    const unauthorized = await fetch(origin + 'models', { headers: { Authorization: 'Bearer wrong' }, signal: AbortSignal.timeout(2000) }); assert.equal(unauthorized.status, 401); assert.ok(!(await unauthorized.text()).includes('wrong'));
    const headers = { Authorization: 'Bearer fixture-client-upstream-key', 'Content-Type': 'application/json' };
    const models = await (await fetch(origin + 'models', { headers, signal: AbortSignal.timeout(2000) })).json(); assert.deepEqual(models.data.map(model => model.id), ['fixture-client-chat', 'fixture-client-responses']);
    const bad = await fetch(origin + 'responses', { method: 'POST', headers, body: JSON.stringify({ model: 'wrong', input: 'must refuse' }), signal: AbortSignal.timeout(2000) }); assert.equal(bad.status, 422); await bad.text();
    assert.equal(metrics.clients.calls.length, 0); assert.equal(metrics.inference, 0); assert.equal(metrics.clients.rejected, 2);
    const good = await fetch(origin + 'responses', { method: 'POST', headers, body: JSON.stringify({ model: 'fixture-client-responses', input: 'allowed' }), signal: AbortSignal.timeout(2000) }); assert.equal(good.status, 200); assert.equal((await good.json()).output[0].content[0].text, 'fixture-client-ok'); assert.equal(metrics.clients.calls.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
