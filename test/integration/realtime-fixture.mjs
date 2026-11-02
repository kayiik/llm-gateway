import assert from 'node:assert/strict';
import { websocketAccept, websocketFrame, websocketReader, websocketMessage } from './websocket-fixture.mjs';

export const realtimeOffer = 'v=0\r\ns=fixture-offer\r\nt=0 0\r\na=ice-pwd:fixture-offer-credential\r\n';
export const realtimeAnswer = 'v=0\r\ns=fixture-answer\r\nt=0 0\r\na=ice-pwd:fixture-answer-credential\r\n';
export const realtimeClientText = '{"type":"session.update","session":{"instructions":"native","provider_number":9007199254740993}}';
export const realtimeServerText = '{"type":"response.function_call_arguments.done","arguments":"{\\"n\\":9007199254740993}"}';
export const realtimeClientBytes = Buffer.from(Array.from({ length: 3072 }, (_, index) => [0, 128, 255][index % 3]));
export const realtimeServerBytes = Buffer.from([0, 128, 255, 7]);
export const geminiInput = Buffer.from(Array.from({ length: 4800 }, (_, index) => [0x10, 0x01, 0xf0, 0xfe][index % 4]));
export const geminiOutput = Buffer.from(Array.from({ length: 4800 }, (_, index) => [0x20, 0x01, 0xe0, 0xfe][index % 4]));

export function createRealtimeFixture(metrics) {
  let releaseSetup;
  const state = () => metrics.realtime ??= { http: [], upgrades: [], rejected: 0, gemini: { connections: 0, setups: 0, turns: 0, toolResults: 0, activities: 0, interruptions: 0, setupReceived: false, setupAcknowledged: false } };
  const upgrade = async (req, socket, head) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const native = url.pathname.match(/^\/realtime\/(native|fallback|bad-handshake|bad-protocol|bad-extensions|bad-upgrade|denied|hold)\/v1\/realtime$/);
    const gemini = url.pathname === '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
    if (!native && !gemini) { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return; }
    const entry = { target: gemini ? 'gemini' : native[1], closed: false }; state().upgrades.push(entry);
    metrics.inference++;
    socket.once('close', () => { entry.closed = true; });
    socket.setTimeout(10000, () => socket.destroy());
    try {
      assert.equal(req.headers.cookie, undefined); assert.equal(req.headers['x-api-key'], undefined); assert.equal(req.headers['x-llmgw-compatibility'], undefined);
      if (gemini) { assert.equal(req.headers['x-goog-api-key'], 'fixture-realtime-key'); assert.equal(req.headers.authorization, undefined); assert.equal(url.search, ''); }
      else { assert.equal(req.headers.authorization, 'Bearer fixture-realtime-key'); assert.equal(req.headers['openai-beta'], 'realtime=v1'); assert.equal(url.searchParams.get('model'), 'voice-model'); }
      if (entry.target === 'denied') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
      const accept = entry.target === 'bad-handshake' ? 'invalid-accept' : websocketAccept(req.headers['sec-websocket-key']);
      const extra = entry.target === 'bad-protocol' ? 'Sec-WebSocket-Protocol: unsolicited\r\n' : entry.target === 'bad-extensions' ? 'Sec-WebSocket-Extensions: unsolicited\r\n' : '';
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${entry.target === 'bad-upgrade' ? 'invalid' : 'websocket'}\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}Set-Cookie: fixture-private=must-not-forward\r\n\r\n`);
      if (entry.target.startsWith('bad-')) { socket.end(); return; }
      const reader = websocketReader(socket, head);
      const send = value => socket.write(websocketFrame(1, typeof value === 'string' ? value : JSON.stringify(value), false));
      if (!gemini) {
        if (entry.target === 'hold') { await reader.next(); return; }
        const text = await reader.next(); assert.equal(text.opcode, 1); assert.equal(text.masked, true); assert.equal(text.payload.toString(), realtimeClientText);
        const binary = await reader.next(); assert.equal(binary.opcode, 2); assert.equal(binary.masked, true); assert.deepEqual(binary.payload, realtimeClientBytes);
        entry.nativeFramesValidated = true;
        send(realtimeServerText); socket.write(websocketFrame(2, realtimeServerBytes, false)); socket.write(websocketFrame(9, 'ping', false));
        const pong = await reader.next(); assert.equal(pong.opcode, 10); assert.equal(pong.payload.toString(), 'ping');
        socket.write(websocketFrame(8, Buffer.from([3, 232]), false));
        const close = await reader.next(); assert.equal(close.opcode, 8); entry.cleanClose = true; socket.end(); return;
      }
      const live = state().gemini; live.connections++;
      let input = Buffer.alloc(0);
      const audio = complete => {
        send({ serverContent: { modelTurn: { role: 'model', parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: geminiOutput.toString('base64') } }] }, outputTranscription: { text: 'fixture spoken answer' } } });
        if (complete) { send({ serverContent: { generationComplete: true } }); send({ serverContent: { turnComplete: true } }); }
      };
      for (;;) {
        const frame = await websocketMessage(reader, (opcode, value) => socket.write(websocketFrame(opcode, value, false)));
        if (frame.opcode === 8) { socket.write(websocketFrame(8, frame.payload, false)); socket.end(); return; }
        if (frame.opcode === 9) { socket.write(websocketFrame(10, frame.payload, false)); continue; }
        assert.equal(frame.opcode, 1); const event = JSON.parse(frame.payload.toString());
        if (event.setup) {
          live.setups++;
          const setup = JSON.stringify(event.setup); assert.ok(setup.includes('models/fixture-live')); assert.ok(setup.includes('"voiceName":"Puck"'));
          live.setupReceived = true;
          await new Promise(resolve => {
            const finish = () => { clearTimeout(timer); if (releaseSetup === finish) releaseSetup = null; resolve(); };
            const timer = setTimeout(finish, 8000); releaseSetup = finish; socket.once('close', finish);
          });
          if (socket.destroyed) return;
          live.setupAcknowledged = true; send({ setupComplete: {} });
        }
        if (event.realtimeInput) {
          const value = event.realtimeInput;
          if (value.activityStart) { live.activities++; if (live.turns === 2 && live.interruptions++ === 0) { audio(false); send({ serverContent: { interrupted: true } }); send({ serverContent: { turnComplete: true } }); } }
          if (value.audio) { assert.equal(value.audio.mimeType, 'audio/pcm;rate=24000'); const bytes = Buffer.from(value.audio.data, 'base64'); assert.equal(bytes.length % 2, 0); input = Buffer.concat([input, bytes]); }
          if (value.activityEnd) {
            assert.deepEqual(input, geminiInput); input = Buffer.alloc(0); live.turns++;
            if (live.turns === 1) audio(true); else if (live.turns === 2) audio(false); else send('{"toolCall":{"functionCalls":[{"id":"fixture-call","name":"lookup","args":{"count":9007199254740993}}]}}');
          }
        }
        if (event.toolResponse) { const value = JSON.stringify(event.toolResponse); assert.ok(value.includes('"id":"fixture-call"') && value.includes('"output":"fixture-result"')); live.toolResults++; audio(true); }
      }
    } catch (error) { if (!/closed|deadline/.test(error.message)) { state().rejected++; entry.error = error.code ?? 'realtime_fixture_mismatch'; } socket.destroy(); }
  };
  const http = async (req, res, path) => {
    if (path === '/realtime/control/setup-release' && req.method === 'POST') { const release = releaseSetup; release?.(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ released: !!release })); return true; }
    const match = path.match(/^\/realtime\/(native|fallback|bad-handshake|bad-protocol|bad-extensions|bad-upgrade|denied|hold)\/v1\/(models|realtime\/calls)$/);
    if (!match) return false;
    res.setHeader('Content-Type', 'application/json');
    if (match[2] === 'models') { res.end('{"data":[{"id":"voice-model","supported_endpoints":["/realtime","/realtime/calls"]},{"id":"chat-model","supported_endpoints":["/chat/completions"]}]}'); return true; }
    metrics.inference++; const entry = { target: match[1], path }; state().http.push(entry);
    try {
      assert.equal(req.headers.authorization, 'Bearer fixture-realtime-key'); assert.equal(req.headers.cookie, undefined); assert.equal(req.headers['x-api-key'], undefined);
      const chunks = []; for await (const part of req) chunks.push(part);
      const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
      assert.equal(form.get('sdp'), realtimeOffer);
      const raw = form.get('session'); assert.equal(typeof raw, 'string'); assert.match(raw, /"provider_number"\s*:\s*9007199254740993/);
      const session = JSON.parse(raw); assert.equal(session.model, 'voice-model'); assert.equal(session.instructions, 'retain <caller> instructions'); assert.equal(session.audio.output.voice, 'marin');
      if (match[1] === 'denied') { res.writeHead(401); res.end('{"error":{"message":"controlled signaling refusal"}}'); return true; }
      res.setHeader('Content-Type', 'application/sdp'); res.setHeader('Location', `http://${req.headers.host}${path}/rtc_fixture`); res.setHeader('Set-Cookie', 'fixture-private=must-not-forward');
      res.writeHead(201); res.end(realtimeAnswer); return true;
    } catch { state().rejected++; res.writeHead(422); res.end('{"error":{"message":"Realtime signaling fixture mismatch."}}'); return true; }
  };
  return { http, upgrade };
}
