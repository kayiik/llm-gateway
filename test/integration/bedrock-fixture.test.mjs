import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('controlled Bedrock compatible endpoint requires bearer and has no SigV4 or Converse fallback', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/bedrock/v1/`;
    const wrong = await fetch(origin + 'models', { headers: { Authorization: 'Bearer wrong-fixture' }, signal: AbortSignal.timeout(2000) }); assert.equal(wrong.status, 401); assert.ok(!(await wrong.text()).includes('wrong-fixture'));
    const headers = { Authorization: 'Bearer fixture-bedrock-bearer', 'Content-Type': 'application/json' };
    const models = await (await fetch(origin + 'models', { headers, signal: AbortSignal.timeout(2000) })).json(); assert.deepEqual(models.data[0].supported_endpoints, ['/responses']);
    const response = await fetch(origin + 'responses', { method: 'POST', headers, body: JSON.stringify({ model: 'fixture-bedrock', input: 'fixture' }), signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); await response.json();
    const unsupported = await fetch(origin + 'converse', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(2000) }); assert.equal(unsupported.status, 404); await unsupported.text();
    assert.equal(metrics.bedrock.invocations, 1); assert.equal(metrics.bedrock.invalidPaths, 1); assert.equal(metrics.bedrock.unauthorized, 1);
    assert.deepEqual(metrics.bedrock.requests[0], { path: '/bedrock/v1/responses', method: 'POST', authScheme: 'Bearer', awsSigned: false, model: 'fixture-bedrock' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
