import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { websocketFrame, websocketReader, websocketMessage } from './websocket-fixture.mjs';

test('websocket fixture reassembles fragmented UTF-8 messages with interleaved control frames', async () => {
  const socket = new PassThrough(); const reader = websocketReader(socket);
  try {
    const text = Buffer.from('fragmented UTF-8: 😀'); const split = text.length - 2;
    const first = websocketFrame(1, text.subarray(0, split), true); first[0] &= 0x7f;
    const bytes = Buffer.concat([first, websocketFrame(9, 'p', true), websocketFrame(0, text.subarray(split), true)]);
    const controls = []; const pending = websocketMessage(reader, (opcode, value) => controls.push([opcode, value.toString()]));
    for (const byte of bytes) socket.write(Buffer.from([byte]));
    const message = await pending; assert.equal(message.opcode, 1); assert.deepEqual(message.payload, text); assert.deepEqual(controls, [[10, 'p']]);
  } finally { socket.destroy(); }
});

test('websocket fixture releases a pending read when the peer half-closes', async () => {
  const socket = new PassThrough(); const reader = websocketReader(socket); const pending = reader.next(2000);
  socket.end(); await assert.rejects(pending, /closed/); socket.destroy();
});
