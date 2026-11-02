import assert from 'node:assert/strict';
import { mediaPNG, mediaWAV } from './media-fixture.mjs';

export function createBrowserGapFixture(metrics) {
  const pendingCuts = new Set();
  return async (req, res, path) => {
    if (!path.startsWith('/browser-gap/')) return false;
    const state = metrics.browserGap ??= { calls: [], rejected: 0, cancelled: 0, terminals: 0 };
    if (path === '/browser-gap/control/cut' && req.method === 'POST') {
      const count = pendingCuts.size; for (const cut of [...pendingCuts]) cut();
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ cut: count })); return true;
    }
    if (path === '/browser-gap/v1/models' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [
        ...['stream-hold', 'stream-cut', 'stream-post-open-cut', 'stream-error'].map(id => ({ id, capabilities: { chat: true }, supported_endpoints: ['/chat/completions'] })),
        { id: 'fixture-image', capabilities: { image: true }, supported_endpoints: ['/images/generations'] },
        { id: 'fixture-speech', capabilities: { tts: true, audio_out: true }, supported_endpoints: ['/audio/speech'] },
      ] })); return true;
    }
    if (req.headers.authorization !== 'Bearer fixture-browser-gap-key') { state.rejected++; res.writeHead(401); res.end('{"error":{"message":"synthetic browser credential rejected"}}'); return true; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const input = JSON.parse(raw); assert.equal(req.method, 'POST');
      if (path === '/browser-gap/v1/chat/completions') {
        assert.ok(['stream-hold', 'stream-cut', 'stream-post-open-cut', 'stream-error'].includes(input.model)); assert.ok(input.messages?.length);
        state.calls.push({ model: input.model, stream: input.stream === true, closed: false }); const call = state.calls.at(-1); metrics.inference++;
        if (input.model === 'stream-error') { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"synthetic upstream unavailable"}}'); return true; }
        assert.equal(input.stream, true); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frame = (delta, finish = null) => 'data: ' + JSON.stringify({ id: 'browser-gap-stream', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
        res.write(frame({ role: 'assistant', content: 'partial fixture answer' }));
        if (input.model === 'stream-cut') { res.flushHeaders(); setTimeout(() => res.end(), 150); return true; }
        if (input.model === 'stream-post-open-cut') {
          const cut = () => { pendingCuts.delete(cut); if (!res.destroyed) { call.endedWithoutTerminal = true; res.end(); } };
          pendingCuts.add(cut); res.on('close', () => pendingCuts.delete(cut));
        }
        res.on('close', () => { if (!res.writableEnded) { call.closed = true; state.cancelled++; } });
        return true;
      }
      if (path === '/browser-gap/v1/images/generations') {
        assert.equal(input.model, 'fixture-image'); assert.ok(input.prompt?.length);
        state.calls.push({ model: input.model, prompt: input.prompt }); metrics.inference++;
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ created: 1, data: [{ b64_json: mediaPNG.toString('base64') }] })); return true;
      }
      if (path === '/browser-gap/v1/audio/speech') {
        assert.equal(input.model, 'fixture-speech'); assert.ok(input.input?.length);
        state.calls.push({ model: input.model, voice: input.voice }); metrics.inference++;
        res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(mediaWAV); return true;
      }
      throw new Error('unsupported browser operation');
    } catch { state.rejected++; res.writeHead(422); res.end('{"error":{"message":"synthetic browser request mismatch"}}'); return true; }
  };
}
