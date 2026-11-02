import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';

test('controlled private allowance distinguishes zero, unknown and wrong credentials without inference', async () => {
  const { server, metrics } = createFakeUpstream(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/quota-daemon`;
    const headers = { Authorization: 'Bearer fixture-extension-secret', 'X-Credential-Token': 'fixture-extension-owner-token' };
    const wrong = await fetch(origin + '/extension/v1/google_antigravity/allowance', { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}', signal: AbortSignal.timeout(2000) }); assert.equal(wrong.status, 401); await wrong.text();
    const unowned = await fetch(origin + '/extension/v1/google_antigravity/allowance', { method: 'POST', headers: { Authorization: 'Bearer fixture-extension-secret' }, body: '{}', signal: AbortSignal.timeout(2000) }); assert.equal(unowned.status, 401); await unowned.text();
    const mode = async value => { const response = await fetch(origin + '/control/allowance', { method: 'POST', body: JSON.stringify({ mode: value }), signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); await response.json(); };
    const allowance = async () => { const response = await fetch(origin + '/extension/v1/google_antigravity/allowance', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); return response.json(); };
    await mode('zero'); const zero = await allowance(); assert.equal(zero.status, 'observed'); assert.equal(zero.observations[0].remaining_fraction, 0);
    await mode('unknown'); const unknown = await allowance(); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.observations, undefined);
    assert.equal(metrics.inference, 0); assert.equal(metrics.extensionQuota.allowanceReads, 2, 'wrong credentials must not reach the allowance reader');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
