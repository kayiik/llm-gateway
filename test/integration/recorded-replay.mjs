import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export function createRecordedReplay(metrics) {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/recorded-groq-chat.json', import.meta.url), 'utf8'));
  const chat = readFileSync(new URL('./fixtures/recorded-groq-chat.sse', import.meta.url), 'utf8');
  const chatUsage = readFileSync(new URL('./fixtures/synthetic-chat-usage.sse', import.meta.url), 'utf8');
  const responses = readFileSync(new URL('./fixtures/recorded-codex-responses.sse', import.meta.url), 'utf8');
  const transcription = JSON.parse(readFileSync(new URL('./fixtures/recorded-groq-transcription.json', import.meta.url), 'utf8'));
  const turns = new Map();
  metrics.recorded = { accepted: {}, rejected: 0 };
  return async (req, res, path) => {
    const [, , wire, scenario] = path.split('/');
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (wire === 'transcription') {
      if (req.method === 'GET' && path.endsWith('/models')) {
        send(200, { data: [{ id: transcription.request.model, supported_endpoints: ['/audio/transcriptions'] }] }); return;
      }
      if (req.method !== 'POST' || !path.endsWith('/audio/transcriptions')) { send(404, {}); return; }
      metrics.inference++;
      const chunks = []; for await (const part of req) chunks.push(part);
      try {
        const form = await new Request('http://fixture/audio/transcriptions', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData();
        const file = form.get('file');
        const bytes = file && typeof file.arrayBuffer === 'function' ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
        const expected = transcription.request;
        if (form.get('model') !== expected.model || form.get('language') !== expected.language || form.get('response_format') !== expected.response_format || file?.type !== expected.upstream_audio_type || bytes.length !== expected.audio_bytes || createHash('sha256').update(bytes).digest('hex') !== expected.audio_sha256) throw new Error('Recorded multipart fields or synthetic audio differ.');
        const key = `${wire}/${scenario}`;
        metrics.recorded.accepted[key] = (metrics.recorded.accepted[key] ?? 0) + 1;
        send(200, transcription.response);
      } catch {
        metrics.recorded.rejected++;
        send(422, { error: { type: 'fixture_mismatch', message: 'Recorded multipart fields or synthetic audio differ.' } });
      }
      return;
    }
    if (!['chat', 'responses', 'responses-tools'].includes(wire)) { send(404, {}); return; }
    const model = wire === 'chat' ? 'recorded-groq-model' : 'fixture-codex-model';
    if (req.method === 'GET' && path.endsWith('/models')) {
      send(200, { data: [{ id: model, supported_endpoints: [wire === 'chat' ? '/chat/completions' : '/responses'] }] }); return;
    }
    if (req.method !== 'POST' || !path.endsWith(wire === 'chat' ? '/chat/completions' : '/responses')) { send(404, {}); return; }
    metrics.inference++;
    let raw = ''; for await (const part of req) raw += part;
    let input;
    try { input = JSON.parse(raw); } catch { send(400, {}); return; }
    const key = `${wire}/${scenario}`;
    const turn = turns.get(key) ?? 0;
    let toolRecording;
    if (wire === 'responses-tools') {
      toolRecording = JSON.parse(readFileSync(new URL('./fixtures/recorded-codex-tools.json', import.meta.url), 'utf8'));
      const expected = structuredClone(toolRecording.turns[turn]?.request);
      if (expected) expected.model = model;
      if (!expected || !isDeepStrictEqual(input, expected)) {
        metrics.recorded.rejected++;
        send(422, { error: { type: 'fixture_mismatch', message: 'Recorded native Responses items or tool-result association differ.' } }); return;
      }
    } else if (wire === 'chat') {
      const expected = structuredClone(fixture.gateway_requests[input.stream ? 2 : turn]);
      if (expected) expected.model = model;
      // Only prepared conversion fixtures require this generated control;
      // retained native requests and responses stay byte-for-byte unchanged.
      if (['translated-usage', 'translated-reasoning'].includes(scenario) && expected?.stream) expected.stream_options = { include_usage: true };
      // The native SDK explicitly writes its false stream default. This is a
      // reconstructed stub expectation; the recorded Gateway request stays intact.
      const actual = structuredClone(input);
      if (actual.stream === false && expected && !('stream' in expected)) delete actual.stream;
      if (!expected || !isDeepStrictEqual(actual, expected)) {
        metrics.recorded.rejected++;
        send(422, { error: { type: 'fixture_mismatch', message: 'Recorded tool/message association or request differs.' } }); return;
      }
    } else if (input.model !== model || input.stream !== true || input.instructions !== 'Reply with exactly OK.' || input.store !== false || !JSON.stringify(input.input).includes('Reply with exactly OK.')) {
      metrics.recorded.rejected++; send(422, { error: { message: 'Recorded Responses request differs.' } }); return;
    }
    metrics.recorded.accepted[key] = (metrics.recorded.accepted[key] ?? 0) + 1;
    if (!input.stream) { turns.set(key, turn + 1); send(200, fixture.responses[turn]); return; }
    if (wire === 'responses-tools') turns.set(key, turn + 1);
    const frames = (toolRecording ? toolRecording.turns[turn].sse : wire === 'chat' ? scenario === 'translated-usage' ? chatUsage : chat : responses).trim().split(/\r?\n\r?\n/);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < frames.length; i++) {
      if (res.destroyed) return;
      if (scenario === 'missing-terminal' && i === frames.length - 1) break;
      res.write(frames[i] + '\n\n');
      if (scenario === 'partial' && i === 2) { res.destroy(); return; }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    res.end();
  };
}
