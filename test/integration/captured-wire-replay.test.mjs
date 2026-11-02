import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createCapturedWireReplay } from './captured-wire-replay.mjs';

test('a private complete outbound recording replays only its exact authenticated request and SSE terminal', async () => {
  const request = Buffer.from('{"model":"fixture","input":"test"}');
  const frames = Buffer.from('data: {"output_text":"ok"}\n\ndata: [DONE]\n\n');
  const caseRecord = { complete: true, request_complete: true, status: 200, method: 'POST', path: '/v1/responses',
    auth_forms: ['bearer'], request_headers: { 'Content-Type': 'application/json' }, response_headers: { 'Content-Type': 'text/event-stream' },
    request_body_base64: request.toString('base64'), response_body_base64: frames.toString('base64'), terminal_event: 'done' };
  assert.throws(() => createCapturedWireReplay([{ ...caseRecord, complete: false }]), /complete/);
  assert.throws(() => createCapturedWireReplay([{ ...caseRecord, response_truncated: true }]), /complete/);
  const { handle, metrics } = createCapturedWireReplay([caseRecord]);
  const server = createServer((req, res) => { void handle(req, res); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}/v1/responses`;
    for (const [body, headers, status] of [
      [request, { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' }, 200],
      [request, { Authorization: 'Basic synthetic-token', 'Content-Type': 'application/json' }, 422],
      [Buffer.from('{"model":"other"}'), { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' }, 422],
    ]) {
      const response = await fetch(origin, { method: 'POST', body, headers, signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, status);
      const actual = Buffer.from(await response.arrayBuffer()); if (status === 200) assert.deepEqual(actual, frames);
    }
    assert.equal(metrics.served.length, 1); assert.equal(metrics.rejected, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
