import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createFakeUpstream } from './fake-upstream.mjs';
import { mediaWAV } from './media-fixture.mjs';

test('media fixture rejects a changed voice or credential instead of returning constant audio', async () => {
  const { server, metrics } = createFakeUpstream();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const body = { model: 'fixture-speech', input: 'Hello.', voice: 'fixture-voice', response_format: 'wav' };
    const send = (extra = {}, token = 'fixture-media-key') => fetch(origin + '/media/speech-main/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }), signal: AbortSignal.timeout(2000) });
    for (const [extra, token] of [[{ voice: 'unrelated-voice' }, 'fixture-media-key'], [{}, 'unrelated-key']]) {
      const response = await send(extra, token); assert.equal(response.status, 422); await response.text();
    }
    const response = await send(); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), mediaWAV);
    assert.equal(metrics.media.rejected, 2); assert.equal(metrics.inference, 3);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
