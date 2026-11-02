import assert from 'node:assert/strict';
import { mediaWAV } from './media-fixture.mjs';

export const nativeAudioMP3 = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000fixture-native-audio');

export function createAudioNativeFixture(metrics) {
  return async (req, res, path) => {
    if (!path.startsWith('/audio-native/')) return false;
    const state = metrics.audioNative ??= { calls: [], catalogs: [], rejected: 0 };
    const match = path.match(/^\/audio-native\/(eleven|mimo|ovh)\/v1\/(.+)$/);
    if (!match) return false;
    const [, type, operation] = match;
    if (req.method === 'GET' && operation === 'models' && type === 'ovh') {
      state.catalogs.push(type); res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"fixture-ovh-speech","supported_endpoints":["/audio/speech"]}]}'); return true;
    }
    const key = type === 'eleven' ? req.headers['xi-api-key'] : type === 'mimo' ? req.headers['api-key'] : req.headers.authorization;
    const expected = type === 'ovh' ? 'Bearer fixture-ovh-audio-key' : 'fixture-audio-native-key';
    if (key !== expected || (type !== 'ovh' && req.headers.authorization)) { state.rejected++; res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"synthetic native audio credential rejected"}}'); return true; }
    let body = Buffer.alloc(0); for await (const chunk of req) body = Buffer.concat([body, chunk]);
    try {
      assert.equal(req.method, 'POST');
      if (type === 'eleven' && operation === 'speech-to-text') {
        const data = body.toString('utf8'); assert.match(req.headers['content-type'] ?? '', /^multipart\/form-data; boundary=/);
        assert.match(data, /name="model_id"[\s\S]*?scribe_v2/); assert.match(data, /filename="sample.wav"/);
        assert.ok(body.includes(mediaWAV), 'upstream transcription must receive actual WAV bytes');
        state.calls.push({ type, operation, model: 'scribe_v2' }); metrics.inference++;
        res.setHeader('Content-Type', 'application/json'); res.end('{"text":"native-audio-transcript","words":[]}'); return true;
      }
      if (type === 'eleven' && operation === 'text-to-speech/fixture-voice') {
        const data = JSON.parse(body); assert.equal(data.text, 'Speak from controlled native audio.'); assert.equal(data.model_id, 'eleven_multilingual_v2');
        assert.equal(new URL(req.url, 'http://fixture.invalid').searchParams.get('output_format'), 'mp3_44100_128');
        state.calls.push({ type, operation, model: data.model_id, voice: 'fixture-voice' }); metrics.inference++;
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(nativeAudioMP3); return true;
      }
      if (type === 'mimo' && operation === 'chat/completions') {
        const data = JSON.parse(body); assert.equal(data.model, 'mimo-v2.5-tts'); assert.equal(data.stream, false);
        assert.deepEqual(data.audio, { format: 'wav', voice: 'mimo_default' });
        assert.deepEqual(data.messages, [{ role: 'user', content: 'Give a greeting.' }, { role: 'assistant', content: 'Speak from controlled native audio.' }]);
        state.calls.push({ type, operation, model: data.model, voice: data.audio.voice }); metrics.inference++;
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { audio: { data: mediaWAV.toString('base64'), format: 'wav' } } }] })); return true;
      }
      if (type === 'ovh' && operation === 'audio/speech') {
        const data = JSON.parse(body); assert.equal(data.model, 'fixture-ovh-speech'); assert.equal(data.voice, 'fixture-voice'); assert.equal(data.response_format, 'wav');
        state.calls.push({ type, operation, model: data.model, voice: data.voice }); metrics.inference++;
        res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(mediaWAV); return true;
      }
      throw new Error('wrong native audio operation');
    } catch { state.rejected++; res.writeHead(422, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"synthetic native audio request mismatch"}}'); return true; }
  };
}
