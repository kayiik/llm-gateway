import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('native Google, audio and browser peers reject wrong credentials without recording inference', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const requests = [
      ['/google-boundary/studio/v1beta/models?pageSize=1000', { method: 'GET' }],
      ['/google-boundary/compatible/v1beta/openai/models', { method: 'GET', headers: { 'x-goog-api-key': 'fixture-google-native-key' } }],
      ['/audio-native/eleven/v1/text-to-speech/fixture-voice', { method: 'POST', headers: { 'xi-api-key': 'wrong' }, body: '{}' }],
      ['/audio-native/mimo/v1/chat/completions', { method: 'POST', headers: { 'Api-Key': 'wrong' }, body: '{}' }],
      ['/browser-gap/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' }],
    ];
    for (const [path, options] of requests) { const response = await fetch(origin + path, { ...options, signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 401, path); await response.text(); }
    assert.equal(metrics.inference, 0);
    assert.equal(metrics.googleBoundary.rejected, 2); assert.equal(metrics.audioNative.rejected, 2); assert.equal(metrics.browserGap.rejected, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
