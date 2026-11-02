import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('external-key HTTP peer requires its source token and honors conditional ETag before replacing its one key', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/external-keys`;
    const denied = await fetch(origin, { signal: AbortSignal.timeout(2000) }); assert.equal(denied.status, 401); await denied.text();
    const headers = { Authorization: 'Bearer fixture-external-source-token' };
    const first = await fetch(origin, { headers, signal: AbortSignal.timeout(2000) }); assert.equal(first.status, 200); assert.equal(first.headers.get('etag'), '"one"'); assert.equal((await first.json()).keys[0].project, 'preserved-project');
    const unchanged = await fetch(origin, { headers: { ...headers, 'If-None-Match': '"one"' }, signal: AbortSignal.timeout(2000) }); assert.equal(unchanged.status, 304); await unchanged.text();
    const rotated = await fetch(origin + '/control', { method: 'POST', body: '{"mode":"two"}', signal: AbortSignal.timeout(2000) }); assert.equal(rotated.status, 200); await rotated.text();
    const next = await fetch(origin, { headers: { ...headers, 'If-None-Match': '"one"' }, signal: AbortSignal.timeout(2000) }); assert.equal(next.status, 200); assert.equal(next.headers.get('etag'), '"two"'); assert.equal((await next.json()).count, 1);
    assert.equal(metrics.externalKeys.responses.one, 1); assert.equal(metrics.externalKeys.responses.unchanged, 1); assert.equal(metrics.externalKeys.responses.two, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
