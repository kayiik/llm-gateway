import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createFakeUpstream } from './fake-upstream.mjs';
import { embeddingRequest } from './embeddings-matrix.mjs';

async function fixture(run) {
  const { server, metrics } = createFakeUpstream();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const send = (body, token = 'fixture-embedding-token') => fetch(origin + '/embedding-matrix/primary/v1/embeddings', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
    });
    await run({ send, metrics });
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('embedding fixture rejects changed payloads and credentials without accepting them', async () => {
  await fixture(async ({ send, metrics }) => {
    for (const changed of [{ input: 'Unrelated input.' }, { dimensions: 4 }, { encoding_format: 'base64' }, { model: 'another-model' }]) {
      const response = await send({ ...embeddingRequest('single'), ...changed });
      assert.equal(response.status, 422); await response.text();
      assert.equal(metrics.embeddings.primary.accepted, 0);
    }
    const unauthenticated = await send(embeddingRequest('single'), 'wrong-fixture-token');
    assert.equal(unauthenticated.status, 401); await unauthenticated.text();
    assert.equal(metrics.embeddings.primary.accepted, 0);
    const valid = await send(embeddingRequest('single'));
    assert.equal(valid.status, 200); await valid.json();
    assert.deepEqual(metrics.embeddings.primary, { attempts: 6, accepted: 1, rejected: 5 });
  });
});

test('embedding fixture distinguishes ordered vectors, reported zero and absent usage', async () => {
  await fixture(async ({ send }) => {
    const batch = await (await send(embeddingRequest('batch'))).json();
    assert.deepEqual(batch.data.map(row => row.index), [0, 1]);
    assert.notDeepEqual(batch.data[0].embedding, batch.data[1].embedding);
    assert.deepEqual(batch.usage, { prompt_tokens: 11, total_tokens: 11 });
    const zero = await (await send(embeddingRequest('zero'))).json();
    assert.deepEqual(zero.usage, { prompt_tokens: 0, total_tokens: 0 });
    const absent = await (await send(embeddingRequest('absent'))).json();
    assert.equal(Object.hasOwn(absent, 'usage'), false);
  });
});
