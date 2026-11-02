import assert from 'node:assert/strict';
import { mediaWAV } from './media-fixture.mjs';
import { nativeAudioMP3 } from './audio-native-fixture.mjs';

export async function runAudioNativeMatrix({ admin, publicCall, metrics, save, registerSecret }) {
  for (const secret of ['fixture-audio-native-key', 'fixture-ovh-audio-key', 'fixture-wrong-audio-key']) registerSecret(secret);
  const result = { boundary: 'Installed native ElevenLabs/MiMo and configured OVH compatible audio against strict synthetic peers; not vendor entitlement or OVH voice-host proof', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('audio-native-matrix.json', result); } };
  const speech = (model, format, voice = 'fixture-voice') => ({ model, input: 'Speak from controlled native audio.', voice, response_format: format });
  await test('elevenlabs-model-declarations-and-native-speech-voice-output-format', async row => {
    await admin('providers', { id: 'audio-eleven-native', registry_id: 'elevenlabs', base_url: 'http://upstream:18889/audio-native/eleven/v1', api_key: 'fixture-audio-native-key' });
    await admin('providers/audio-eleven-native/refresh', {});
    const before = (await metrics()).audioNative?.calls?.length ?? 0;
    const answer = await publicCall('eleven-native-speech', '/v1/audio/speech', speech('audio-eleven-native/eleven_multilingual_v2', 'mp3'));
    assert.equal(answer.status, 200, answer.text); assert.match(answer.contentType, /audio\/mpeg/);
    assert.deepEqual(Buffer.from(answer.bodyBase64, 'base64'), nativeAudioMP3);
    assert.deepEqual((await metrics()).audioNative.calls.slice(before).map(call => [call.type, call.model, call.voice]), [['eleven', 'eleven_multilingual_v2', 'fixture-voice']]); row.sourceCalls = 1;
  });
  await test('elevenlabs-transcription-forwards-multipart-model-and-wav-file', async row => {
    const before = (await metrics()).audioNative.calls.length;
    const input = new FormData(); input.set('model', 'audio-eleven-native/scribe_v2'); input.set('file', new File([mediaWAV], 'sample.wav', { type: 'audio/wav' }));
    const answer = await publicCall('eleven-native-transcription', '/v1/audio/transcriptions', input);
    assert.equal(answer.status, 200, answer.text); assert.equal(JSON.parse(answer.text).text, 'native-audio-transcript');
    assert.deepEqual((await metrics()).audioNative.calls.slice(before).map(call => [call.type, call.operation]), [['eleven', 'speech-to-text']]); row.sourceCalls = 1;
  });
  await test('elevenlabs-unsupported-speech-format-refuses-before-source-io', async row => {
    const before = (await metrics()).audioNative.calls.length;
    const refused = await publicCall('eleven-native-wav-refusal', '/v1/audio/speech', speech('audio-eleven-native/eleven_multilingual_v2', 'wav'));
    assert.equal(refused.status, 400, refused.text); assert.equal((await metrics()).audioNative.calls.length, before); row.sourceCalls = 0;
  });
  await test('mimo-speech-converts-exact-instructions-voice-wav-and-api-key-header', async row => {
    await admin('providers', { id: 'audio-mimo-native', registry_id: 'mimo', base_url: 'http://upstream:18889/audio-native/mimo/v1', api_key: 'fixture-audio-native-key' });
    await admin('providers/audio-mimo-native/refresh', {});
    const before = (await metrics()).audioNative.calls.length;
    const answer = await publicCall('mimo-native-speech', '/v1/audio/speech', { ...speech('audio-mimo-native/mimo-v2.5-tts', 'wav', 'mimo_default'), instructions: 'Give a greeting.' });
    assert.equal(answer.status, 200, answer.text); assert.match(answer.contentType, /audio\/wav/);
    assert.deepEqual(Buffer.from(answer.bodyBase64, 'base64'), mediaWAV);
    assert.deepEqual((await metrics()).audioNative.calls.slice(before).map(call => [call.type, call.model, call.voice]), [['mimo', 'mimo-v2.5-tts', 'mimo_default']]); row.sourceCalls = 1;
  });
  await test('mimo-invalid-format-and-wrong-credential-never-return-audio', async row => {
    const before = (await metrics()).audioNative.calls.length;
    const badFormat = await publicCall('mimo-native-mp3-refusal', '/v1/audio/speech', speech('audio-mimo-native/mimo-v2.5-tts', 'mp3', 'mimo_default'));
    assert.equal(badFormat.status, 400, badFormat.text); assert.equal((await metrics()).audioNative.calls.length, before);
    await admin('providers', { id: 'audio-mimo-wrong', registry_id: 'mimo', base_url: 'http://upstream:18889/audio-native/mimo/v1', api_key: 'fixture-wrong-audio-key' });
    await admin('providers/audio-mimo-wrong/refresh', {});
    const failed = await publicCall('mimo-native-wrong-key', '/v1/audio/speech', speech('audio-mimo-wrong/mimo-v2.5-tts', 'wav', 'mimo_default'));
    assert.ok(failed.status >= 400, failed.text); assert.ok(!failed.text.includes('fixture-wrong-audio-key'));
    assert.ok((await metrics()).audioNative.rejected >= 1); row.status = failed.status;
  });
  await test('ovh-configured-compatible-speech-routes-selected-model-voice-and-wav', async row => {
    await admin('providers', { id: 'audio-ovh-compatible', registry_id: 'ovh_ai_endpoints', base_url: 'http://upstream:18889/audio-native/ovh/v1', api_key: 'fixture-ovh-audio-key' });
    await admin('providers/audio-ovh-compatible/refresh', {});
    const before = (await metrics()).audioNative.calls.length;
    const answer = await publicCall('ovh-compatible-speech', '/v1/audio/speech', speech('audio-ovh-compatible/fixture-ovh-speech', 'wav'));
    assert.equal(answer.status, 200, answer.text); assert.match(answer.contentType, /audio\/wav/);
    assert.deepEqual(Buffer.from(answer.bodyBase64, 'base64'), mediaWAV);
    assert.deepEqual((await metrics()).audioNative.calls.slice(before).map(call => [call.type, call.model, call.voice]), [['ovh', 'fixture-ovh-speech', 'fixture-voice']]); row.sourceCalls = 1;
  });
  result.pass = result.cases.length === 6 && result.cases.every(row => row.pass); save('audio-native-matrix.json', result);
  assert.equal(result.pass, true, result.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
