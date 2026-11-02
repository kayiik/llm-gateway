import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeUpstream } from './fake-upstream.mjs';
import { matrixRequest, readMatrixReply } from './streaming-tool-matrix.mjs';

for (const wire of ['chat', 'responses', 'messages']) test(`${wire} matrix fixture rejects a mismatched actual tool result without advancing`, async t => {
  const { server, metrics } = createFakeUpstream();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const path = { chat: '/chat/completions', responses: '/responses', messages: '/v1/messages' }[wire];
  const origin = `http://127.0.0.1:${server.address().port}/matrix/${wire}/fixture${path}`;
  const send = body => fetch(origin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const first = await send(matrixRequest(wire, 'fixture'));
  assert.equal(first.status, 200);
  const answer = readMatrixReply(wire, await first.text(), false);
  const valid = matrixRequest(wire, 'fixture', answer);
  const wrong = structuredClone(valid);
  if (wire === 'responses') wrong.input.at(-1).call_id = 'wrong-association';
  else if (wire === 'messages') wrong.messages.at(-1).content[0].tool_use_id = 'wrong-association';
  else wrong.messages.at(-1).tool_call_id = 'wrong-association';
  const rejected = await send(wrong);
  assert.equal(rejected.status, 422);
  await rejected.text();
  assert.equal(metrics.matrix[wire + '/fixture'].accepted, 1);
  const second = await send(valid);
  assert.equal(second.status, 200);
  readMatrixReply(wire, await second.text(), true);
  assert.deepEqual(metrics.matrix[wire + '/fixture'], { attempts: 3, accepted: 2, rejected: 1 });
});
