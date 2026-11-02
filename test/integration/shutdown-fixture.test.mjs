import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('shutdown fixture keeps an actual authenticated stream open until explicit release', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/shutdown/`;
    const denied = await fetch(origin + 'v1/models', { signal: AbortSignal.timeout(2000) }); assert.equal(denied.status, 401); await denied.text();
    const headers = { Authorization: 'Bearer fixture-shutdown-token', 'Content-Type': 'application/json' };
    const wrong = await fetch(origin + 'v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'other', stream: true, messages: [{ role: 'user', content: 'hold until released' }] }), signal: AbortSignal.timeout(2000) }); assert.equal(wrong.status, 422); await wrong.text();
    assert.equal(metrics.shutdown.starts, 0);
    const response = await fetch(origin + 'v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'fixture', stream: true, messages: [{ role: 'user', content: 'hold until released' }] }), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200); const reader = response.body.getReader(), first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /chat\.completion\.chunk/);
    assert.equal(metrics.shutdown.starts, 1); assert.equal(metrics.shutdown.completed, 0);
    const release = await fetch(origin + 'control/release', { method: 'POST', signal: AbortSignal.timeout(2000) }); assert.deepEqual(await release.json(), { released: 1 });
    let remaining = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; remaining += new TextDecoder().decode(chunk.value); }
    assert.match(remaining, /drained-fixture/); assert.match(remaining, /data: \[DONE\]/);
    assert.equal(metrics.shutdown.completed, 1); assert.equal(metrics.shutdown.cancelled, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
