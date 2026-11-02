import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('compatible fixture refuses mismatched credentials/model and separates anonymous from keyed hosts', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/compatible/`;
    const invalid = await fetch(origin + 'localai/v1/models', { signal: AbortSignal.timeout(2000) }); assert.equal(invalid.status, 401); await invalid.text();
    const anonymous = await fetch(origin + 'localai-anon/v1/models', { signal: AbortSignal.timeout(2000) }); assert.equal(anonymous.status, 200); await anonymous.json();
    const headers = { Authorization: 'Bearer fixture-compatible-key', 'Content-Type': 'application/json' };
    const wrong = await fetch(origin + 'localai/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'wrong', messages: [{ role: 'user', content: 'Return the controlled answer.' }] }), signal: AbortSignal.timeout(2000) }); assert.equal(wrong.status, 422); await wrong.text();
    assert.equal(metrics.compatible.calls.length, 0); assert.equal(metrics.compatible.rejected, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
