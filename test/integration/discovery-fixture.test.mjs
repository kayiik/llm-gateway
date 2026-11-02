import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('controlled catalog waits for release and abandons a caller that cancelled', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/discovery/`;
    const wrong = await fetch(origin + 'v1/models', { headers: { Authorization: 'Bearer wrong' }, signal: AbortSignal.timeout(2000) }); assert.equal(wrong.status, 401); await wrong.text();
    const controller = new AbortController(); const request = fetch(origin + 'v1/models', { headers: { Authorization: 'Bearer fixture-discovery-token' }, signal: controller.signal });
    for (let attempt = 0; attempt < 40 && metrics.discovery.listed === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(metrics.discovery.listed, 1); assert.equal(metrics.discovery.completed, 0);
    controller.abort(); await assert.rejects(request);
    for (let attempt = 0; attempt < 40 && metrics.discovery.left === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(metrics.discovery.left, 1); assert.equal(metrics.inference, 0);
    const release = await fetch(origin + 'control/release', { method: 'POST', signal: AbortSignal.timeout(2000) }); assert.equal(release.status, 200); await release.text();
    const models = await fetch(origin + 'v1/models', { headers: { Authorization: 'Bearer fixture-discovery-token' }, signal: AbortSignal.timeout(2000) }); assert.equal(models.status, 200); assert.equal((await models.json()).data[0].id, 'fixture-discovery-model');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
