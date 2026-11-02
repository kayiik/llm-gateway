import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('Azure peer requires api-key and exposes deployments rather than an untruthful generic catalog', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/azure/resource/openai/`;
    const wrong = await fetch(origin + 'deployments?api-version=2023-03-15-preview', { headers: { Authorization: 'Bearer fixture-azure-key' }, signal: AbortSignal.timeout(2000) }); assert.equal(wrong.status, 401); await wrong.text();
    const headers = { 'api-key': 'fixture-azure-key' };
    const deployments = await fetch(origin + 'deployments?api-version=2023-03-15-preview', { headers, signal: AbortSignal.timeout(2000) }); assert.equal(deployments.status, 200); assert.equal((await deployments.json()).data.length, 2);
    const falseCatalog = await fetch(origin + 'v1/models', { headers, signal: AbortSignal.timeout(2000) }); assert.equal(falseCatalog.status, 422); await falseCatalog.text();
    assert.equal(metrics.azure.rejected, 1); assert.equal(metrics.azure.wrongCatalog, 1); assert.equal(metrics.inference, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
