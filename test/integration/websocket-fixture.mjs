import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export const websocketAccept = key => createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

export function websocketFrame(opcode, value, masked) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const prefix = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
  if (!masked) return Buffer.concat([prefix, payload]);
  prefix[1] |= 0x80; const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([prefix, mask, Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))]);
}

export function websocketReader(socket, head = Buffer.alloc(0)) {
  let buffer = head, failure;
  const frames = [], waiting = [];
  const end = error => { failure ??= error; for (const item of waiting.splice(0)) { clearTimeout(item.timer); item.reject(failure); } };
  const parse = () => {
    while (buffer.length >= 2) {
      let length = buffer[1] & 127, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      if (length === 127) { if (buffer.length < 10) return; const wide = buffer.readBigUInt64BE(2); if (wide > 1048576n) { end(new Error('fixture frame exceeds its bound')); socket.destroy(); return; } length = Number(wide); offset = 10; }
      const masked = (buffer[1] & 128) !== 0, start = offset + (masked ? 4 : 0);
      if (buffer.length < start + length) return;
      const raw = Buffer.from(buffer.subarray(0, start + length));
      const payload = Buffer.from(buffer.subarray(start, start + length));
      if (masked) for (let index = 0; index < payload.length; index++) payload[index] ^= buffer[offset + index % 4];
      const frame = { opcode: buffer[0] & 15, fin: (buffer[0] & 128) !== 0, masked, payload, raw }; buffer = buffer.subarray(start + length);
      const item = waiting.shift(); if (item) { clearTimeout(item.timer); item.resolve(frame); } else frames.push(frame);
    }
  };
  socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); parse(); });
  socket.on('error', end); socket.on('end', () => end(new Error('fixture websocket closed'))); socket.on('close', () => end(new Error('fixture websocket closed'))); parse();
  const next = (timeout = 5000, optional = false) => {
    if (frames.length) return Promise.resolve(frames.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, timer: null };
      item.timer = setTimeout(() => { const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1); optional ? resolve(null) : reject(new Error('fixture websocket deadline')); }, timeout);
      waiting.push(item);
    });
  };
  return { next, tryNext: timeout => next(timeout, true) };
}

export function connectWebsocket(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const req = http.request(url, { method: 'GET', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...headers } });
    req.setTimeout(8000, () => req.destroy(new Error('fixture handshake deadline'))); req.on('error', reject);
    req.on('response', response => { let text = ''; response.setEncoding('utf8'); response.on('data', part => { text += part; }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text, close: () => req.destroy() })); });
    req.on('upgrade', (response, socket, head) => {
      if (response.headers['sec-websocket-accept'] !== websocketAccept(key)) { socket.destroy(); reject(new Error('invalid caller websocket accept')); return; }
      const reader = websocketReader(socket, head);
      resolve({ status: response.statusCode, headers: response.headers, reader, socket, send: (opcode, value) => socket.write(websocketFrame(opcode, value, true)), json: value => socket.write(websocketFrame(1, typeof value === 'string' ? value : JSON.stringify(value), true)), close: () => socket.destroy() });
    });
    req.end();
  });
}

export async function websocketMessage(reader, control) {
  const parts = []; let opcode;
  for (let count = 0; count < 1024; count++) {
    const frame = await reader.next();
    if (frame.opcode === 9) { control?.(10, frame.payload); continue; }
    if (frame.opcode >= 8) return frame;
    if (frame.opcode !== 0) { if (opcode !== undefined) throw new Error('nested fixture websocket message'); opcode = frame.opcode; }
    else if (opcode === undefined) throw new Error('unexpected fixture continuation');
    parts.push(frame.payload);
    if (frame.fin) return { ...frame, opcode, payload: Buffer.concat(parts) };
  }
  throw new Error('fixture fragmented-message bound');
}

export async function websocketEvent(connection, kind, seen = []) {
  for (let count = 0; count < 100; count++) {
    const frame = await websocketMessage(connection.reader, (opcode, value) => connection.send(opcode, value));
    if (frame.opcode !== 1) throw new Error('expected a JSON event, got frame ' + frame.opcode);
    const event = JSON.parse(frame.payload.toString('utf8')); seen.push(event);
    if (event.type === 'error' && kind !== 'error') throw new Error('realtime event error: ' + JSON.stringify(event.error));
    if (event.type === kind) return event;
  }
  throw new Error('expected realtime event did not arrive: ' + kind);
}
