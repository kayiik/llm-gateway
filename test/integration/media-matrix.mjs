import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mediaPNG, mediaMP4, mediaWAV } from './media-fixture.mjs';
import { primeCallerCatalog } from './catalog-prime.mjs';

const imageModel = 'gemini-3.1-flash-image', videoModel = 'veo-3.0-generate-001';

export async function runMediaMatrix({ admin, request, publicCall, metrics, save }) {
  const evidence = { boundary: 'Installed Google embedding/image/video and compatible binary audio, with rejecting local protocol fixtures', pass: false, cases: [] };
  const test = async (name, run) => {
    const row = { name, pass: false }; evidence.cases.push(row);
    try { await run(row); row.pass = true; } catch (error) { row.error = error.message; }
    finally { save('media-matrix.json', evidence); }
  };
  const calls = async () => (await metrics()).media?.calls ?? [];
  const beforeAll = (await calls()).length;
  const route = (name, members, ingress) => admin('endpoints', { name, ingress: [ingress], failover: members.map(([provider, model]) => ({ provider, model })) });
  for (const target of ['studio', 'studio-next', 'studio-error', 'vertex']) {
    await admin('providers', { id: 'media-' + target, type: target === 'vertex' ? 'vertex_ai' : 'ai_studio', base_url: `http://upstream:18889/media/${target}/v1`, api_key: 'fixture-media-key', timeout: 2, ...(target === 'vertex' ? { project: 'fixture-project', location: 'global' } : {}) });
    if (target !== 'vertex') await admin(`providers/media-${target}/refresh`, {});
  }
  for (const target of ['speech-main', 'speech-next', 'speech-error', 'speech-stream', 'speech-truncated', 'speech-redirect', 'siliconflow']) {
    await admin('providers', { id: 'media-' + target, registry_id: target === 'siliconflow' ? 'siliconflow' : 'openai', base_url: `http://upstream:18889/media/${target}/v1`, api_key: 'fixture-media-key', timeout: 2 });
    await admin(`providers/media-${target}/refresh`, {});
  }
  const project = await admin('projects', { slug: 'media-matrix', name: 'Media matrix' });
  const caller = await admin('keys', { project_id: project.id, name: 'Media matrix caller', daily_requests: 100 });
  await route('media-image-route', [['media-studio', imageModel], ['media-studio-next', imageModel]], '/v1/images/generations');
  await route('media-image-refusal-route', [['media-studio-error', imageModel], ['media-studio-next', imageModel]], '/v1/images/generations');
  await route('media-video-route', [['media-studio', videoModel], ['media-studio-next', videoModel]], '/v1/videos/generations');
  await route('media-speech-route', [['media-speech-main', 'fixture-speech'], ['media-speech-next', 'fixture-speech']], '/v1/audio/speech');
  await route('media-speech-refusal-route', [['media-speech-error', 'fixture-speech'], ['media-speech-next', 'fixture-speech']], '/v1/audio/speech');
  const image = (extra = {}) => ({ model: 'media-image-route', prompt: 'an origami crane', n: 1, response_format: 'b64_json', ...extra });
  const speech = (model = 'media-speech-route') => ({ model, input: 'Hello.', voice: 'fixture-voice', response_format: 'wav' });
  const noIO = async (name, path, body, status, token = caller.token) => {
    const before = (await calls()).length; const response = await publicCall('media-' + name, path, body, token);
    assert.equal(response.status, status, response.text); assert.equal((await calls()).length, before, 'local media refusal must precede provider I/O');
  };
  await test('google-discovery-pages-and-unsupported-models', async row => {
    await primeCallerCatalog({ admin, request, metrics, caller, provider: 'media-studio', alias: 'gemini-3.5-flash' });
    const state = await metrics();
    assert.ok(state.media.catalogs.some(item => item.target === 'studio' && item.page === 'page-2'));
    const catalog = await request('/v1/models', undefined, caller.token); assert.equal(catalog.status, 200);
    const ids = JSON.parse(catalog.text).data.map(item => item.id);
    save('media-public-catalog.json', JSON.parse(catalog.text)); row.advertisedMediaIDs = ids.filter(id => id.startsWith('media-'));
    assert.ok(ids.includes('media-studio/' + videoModel)); assert.ok(ids.includes('media-studio/gemini-embedding-001'));
    assert.ok(!ids.includes('media-studio/legacy-unsupported')); row.paginated = true;
  });
  await test('siliconflow-selected-qwen-model-preserves-one-float-vector', async row => {
    const before = (await calls()).length;
    const response = await publicCall('media-siliconflow-embedding', '/v1/embeddings', { model: 'media-siliconflow/Qwen/Qwen3-Embedding-0.6B', input: 'hello', encoding_format: 'float' }, caller.token);
    assert.equal(response.status, 200, response.text);
    const body = JSON.parse(response.text); assert.equal(body.model, 'Qwen/Qwen3-Embedding-0.6B');
    assert.deepEqual(body.data, [{ object: 'embedding', index: 0, embedding: [0.125, -0.25, 0.5] }]);
    assert.deepEqual((await calls()).slice(before).map(item => item.target), ['siliconflow']); row.exactModel = body.model;
  });
  for (const [surface, model] of [['studio', 'gemini-embedding-001'], ['vertex', 'text-embedding-005']]) await test('native-google-embedding-' + surface, async row => {
    const before = (await calls()).length;
    const response = await publicCall('media-google-embedding-' + surface, '/v1/embeddings', { model: 'media-' + surface + '/' + model, input: ['first', 'second'], encoding_format: 'float' }, caller.token);
    assert.equal(response.status, 200, response.text);
    const body = JSON.parse(response.text); assert.equal(body.object, 'list'); assert.equal(body.model, model);
    assert.deepEqual(body.data.map(item => [item.index, item.embedding]), [[0, [0.125, -0.25, 0.5]], [1, [-0.5, 0.625, 0.75]]]);
    if (surface === 'vertex') assert.equal(body.usage.prompt_tokens, 8);
    const actual = (await calls()).slice(before); assert.ok(actual.length > 0 && actual.every(item => item.target === surface && item.kind === 'embedding')); row.providerCalls = actual.length;
  });
  for (const [name, extra] of [['dimensions', { dimensions: 3 }], ['encoding', { encoding_format: 'base64' }], ['mixed-input', { input: ['first', 17] }], ['stream', { stream: true }]]) await test('native-google-embedding-refuses-' + name, async () => {
    await noIO('google-embedding-' + name, '/v1/embeddings', { model: 'media-studio/gemini-embedding-001', input: 'hello', ...extra }, 400);
  });
  await test('google-inline-image-is-exact-and-uses-only-first-target', async row => {
    const before = (await calls()).length;
    const response = await publicCall('media-google-image', '/v1/images/generations', image(), caller.token);
    assert.equal(response.status, 200, response.text);
    const body = JSON.parse(response.text); assert.equal(body.model, imageModel); assert.equal(body.data.length, 1);
    assert.deepEqual(Buffer.from(body.data[0].b64_json, 'base64'), mediaPNG);
    assert.deepEqual((await calls()).slice(before).map(item => item.target), ['studio']); row.bytes = mediaPNG.length;
  });
  for (const [name, extra] of [['zero-count', { n: 0 }], ['negative-count', { n: -1 }], ['url-format', { response_format: 'url' }], ['blank-prompt', { prompt: '   ' }], ['text-only-model', { model: 'media-studio/gemini-3.5-flash' }]]) await test('image-refuses-' + name, async () => { await noIO('image-' + name, '/v1/images/generations', image(extra), 400); });
  await test('invalid-or-unsafe-generated-image-is-not-success', async row => {
    for (const prompt of ['unsafe image', 'empty image']) {
      const response = await publicCall('media-' + prompt.replaceAll(' ', '-'), '/v1/images/generations', image({ prompt }), caller.token);
      assert.ok(response.status >= 400, response.text); assert.doesNotMatch(response.text, /<svg|onload=/);
    }
    row.invalidOutputs = 2;
  });
  await test('image-terminal-auth-error-never-selects-another-provider', async row => {
    const before = (await calls()).length;
    const response = await publicCall('media-image-terminal', '/v1/images/generations', image({ model: 'media-image-refusal-route' }), caller.token);
    assert.equal(response.status, 401, response.text); assert.deepEqual((await calls()).slice(before).map(item => item.target), ['studio-error']); row.upstreamCalls = 1;
  });
  const startVideo = async (name, kind, model = 'media-video-route') => {
    const before = (await calls()).length;
    const response = await publicCall('media-video-start-' + name, '/v1/videos/generations', { model, prompt: kind, parameters: { resolution: '720p' } }, caller.token);
    assert.equal(response.status, 202, response.text);
    const started = (await calls()).slice(before).find(item => item.kind === 'video-start');
    assert.equal(started?.resolution, '720p', 'an explicitly supplied resolution must reach the selected source');
    const body = JSON.parse(response.text); assert.equal(body.status, 'running'); assert.ok(body.operation && !body.operation.startsWith('http'));
    return body;
  };
  const poll = (name, job, model = 'media-video-route') => publicCall('media-video-poll-' + name, '/v1/videos/generations', { model, operation: job.operation }, caller.token);
  let inlineJob, downloadJob;
  await test('video-start-and-repeated-inline-poll-preserve-job-identity', async row => {
    inlineJob = await startVideo('inline', 'inline');
    const before = (await calls()).length;
    for (const name of ['first', 'repeat']) {
      const response = await poll('inline-' + name, inlineJob); assert.equal(response.status, 200, response.text);
      const body = JSON.parse(response.text); assert.equal(body.status, 'completed'); assert.equal(body.operation, inlineJob.operation); assert.equal(body.provider, 'media-studio');
      assert.deepEqual(Buffer.from(body.video_base64, 'base64'), mediaMP4); assert.equal(body.mime_type, 'video/mp4');
    }
    assert.deepEqual((await calls()).slice(before).map(item => item.kind), ['video-poll', 'video-poll']); row.noNewGeneration = true;
  });
  await test('cancelled-video-poll-does-not-claim-to-cancel-the-provider-job', async row => {
    const job = await startVideo('held', 'held'); const before = (await calls()).length;
    const controller = new AbortController();
    const pending = fetch(process.env.REPLAY_ORIGIN + '/v1/videos/generations', { method: 'POST', headers: { Authorization: 'Bearer ' + caller.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'media-video-route', operation: job.operation }), signal: controller.signal });
    for (let attempt = 0; attempt < 60 && (await calls()).length === before; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await calls()).length, before + 1, 'the controlled provider must be holding the first poll before the client cancels');
    controller.abort(); await assert.rejects(pending);
    for (let attempt = 0; attempt < 60 && !(await calls())[before].cancelled; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await calls())[before].cancelled, true, 'the in-flight poll must close at the provider');
    const next = await poll('after-cancel', job); assert.equal(next.status, 200, next.text);
    assert.equal(JSON.parse(next.text).operation, job.operation, 'the durable operation handle remains pollable');
    assert.deepEqual(Buffer.from(JSON.parse(next.text).video_base64, 'base64'), mediaMP4);
    assert.deepEqual((await calls()).slice(before).map(item => item.kind), ['video-poll', 'video-poll', 'file']);
    row.pollCancelled = true; row.providerJobCancellationClaimed = false;
  });
  await test('video-handles-refuse-cross-provider-cross-model-and-full-url-polls', async row => {
    assert.ok(inlineJob);
    await noIO('video-other-model', '/v1/videos/generations', { model: 'media-studio/veo-3.0-generate-002', operation: inlineJob.operation }, 403);
    await noIO('video-other-provider', '/v1/videos/generations', { model: 'media-studio-next/' + videoModel, operation: inlineJob.operation }, 403);
    await noIO('video-full-url', '/v1/videos/generations', { model: 'media-video-route', operation: 'http://untrusted:18889/stolen' }, 400);
    await noIO('video-malformed-handle', '/v1/videos/generations', { model: 'media-video-route', operation: inlineJob.operation + '!' }, 400); row.refusals = 4;
  });
  await test('video-route-edit-cannot-rebind-an-existing-job', async row => {
    assert.ok(inlineJob);
    try {
      await route('media-video-route', [['media-studio-next', videoModel], ['media-studio', videoModel]], '/v1/videos/generations');
      await noIO('video-changed-route', '/v1/videos/generations', { model: 'media-video-route', operation: inlineJob.operation }, 403);
    } finally { await route('media-video-route', [['media-studio', videoModel], ['media-studio-next', videoModel]], '/v1/videos/generations'); }
    const response = await poll('restored-route', inlineJob); assert.equal(response.status, 200, response.text); row.boundToOriginalTarget = true;
  });
  await test('eligible-same-origin-video-download-is-authenticated-and-exact', async row => {
    downloadJob = await startVideo('download', 'download'); const before = (await calls()).length;
    const response = await poll('download', downloadJob); assert.equal(response.status, 200, response.text);
    const body = JSON.parse(response.text); assert.deepEqual(Buffer.from(body.video_base64, 'base64'), mediaMP4);
    const actual = (await calls()).slice(before); assert.deepEqual(actual.map(item => item.kind), ['video-poll', 'file']); assert.ok(actual.every(item => item.host === 'upstream:18889')); row.videoBytes = body.video_bytes;
  });
  await test('foreign-video-result-remains-uri-without-request-or-credential-leak', async row => {
    const job = await startVideo('cross', 'cross'); const before = (await calls()).length;
    const response = await poll('cross', job); assert.equal(response.status, 200, response.text);
    const body = JSON.parse(response.text); assert.match(body.video_uri, /^http:\/\/untrusted:/); assert.equal(body.video_base64, undefined);
    assert.deepEqual((await calls()).slice(before).map(item => item.kind), ['video-poll']); row.foreignRequests = 0;
  });
  await test('video-file-redirect-mime-and-invalid-mp4-refuse-without-replay', async row => {
    for (const kind of ['redirect', 'wrong-mime', 'invalid-video']) {
      const job = await startVideo(kind, kind); const before = (await calls()).length;
      const response = await poll(kind, job); assert.ok(response.status >= 400, response.text);
      const actual = (await calls()).slice(before); assert.deepEqual(actual.map(item => item.kind), ['video-poll', 'file']);
      assert.ok(actual.every(item => item.host === 'upstream:18889'), 'redirect destination must never receive credentials or a request');
    }
    row.invalidDownloads = 3;
  });
  await test('vertex-video-poll-uses-operation-derived-model-and-project-location', async row => {
    const model = 'media-vertex/' + videoModel;
    const job = await startVideo('vertex', 'inline', model); const before = (await calls()).length;
    const response = await poll('vertex', job, model); assert.equal(response.status, 200, response.text);
    assert.deepEqual(Buffer.from(JSON.parse(response.text).video_base64, 'base64'), mediaMP4);
    const actual = (await calls()).slice(before); assert.equal(actual.length, 1); assert.match(actual[0].path, /:fetchPredictOperation$/); row.derivedModel = videoModel;
  });
  await test('compatible-speech-preserves-selected-voice-format-and-binary-bytes', async row => {
    const before = (await calls()).length; const response = await publicCall('media-speech', '/v1/audio/speech', speech(), caller.token);
    assert.equal(response.status, 200, response.text); assert.match(response.contentType, /audio\/wav/);
    assert.deepEqual(Buffer.from(response.bodyBase64, 'base64'), mediaWAV);
    assert.deepEqual((await calls()).slice(before).map(item => item.target), ['speech-main']); row.audioBytes = mediaWAV.length;
  });
  await test('speech-terminal-error-and-redirect-never-fall-back-or-forward-credentials', async row => {
    for (const [name, model, status, target] of [['auth', 'media-speech-refusal-route', 401, 'speech-error'], ['redirect', 'media-speech-redirect/fixture-speech', 302, 'speech-redirect']]) {
      const before = (await calls()).length; const response = await publicCall('media-speech-' + name, '/v1/audio/speech', speech(model), caller.token);
      assert.equal(response.status, status, response.text); assert.deepEqual((await calls()).slice(before).map(item => item.target), [target]); assert.equal(response.headers.location, undefined);
    }
    row.terminalFailures = 2;
  });
  const openSpeech = async target => {
    const controller = new AbortController();
    const response = await fetch(process.env.REPLAY_ORIGIN + '/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + caller.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...speech('media-' + target + '/fixture-speech'), stream: true }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    assert.equal(response.status, 200); const reader = response.body.getReader(); const first = await reader.read();
    assert.equal(first.done, false); assert.deepEqual(Buffer.from(first.value), mediaWAV.subarray(0, 44));
    return { controller, reader, bytes: [Buffer.from(first.value)] };
  };
  const release = async target => { const response = await fetch('http://127.0.0.1:18889/media/' + target + '/v1/control/release', { method: 'POST', signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); assert.equal((await response.json()).released, true); };
  await test('audio-stream-flushes-before-source-completion', async row => {
    const opened = await openSpeech('speech-stream');
    try {
      assert.notEqual((await calls()).at(-1).completed, true, 'the provider is still held behind the fixture release barrier');
      await release('speech-stream');
      for (;;) { const part = await opened.reader.read(); if (part.done) break; opened.bytes.push(Buffer.from(part.value)); }
      assert.deepEqual(Buffer.concat(opened.bytes), mediaWAV); row.streamedBeforeCompletion = true;
    } finally { opened.controller.abort(); await opened.reader.cancel().catch(() => {}); }
  });
  await test('audio-stream-cancellation-closes-the-single-upstream', async row => {
    const before = (await calls()).length; const opened = await openSpeech('speech-stream'); opened.controller.abort(); await assert.rejects(opened.reader.read());
    for (let attempt = 0; attempt < 40 && !(await calls()).at(-1).cancelled; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    const actual = (await calls()).slice(before); assert.equal(actual.length, 1); assert.equal(actual[0].cancelled, true); row.upstreamCancelled = true;
  });
  await test('post-byte-audio-truncation-is-observable-without-fallback', async row => {
    const before = (await calls()).length; const opened = await openSpeech('speech-truncated');
    try {
      await release('speech-truncated'); let failure = false;
      try { for (;;) { const part = await opened.reader.read(); if (part.done) break; opened.bytes.push(Buffer.from(part.value)); } } catch { failure = true; }
      assert.equal(failure, true, 'truncated streaming audio must abort delivery'); assert.equal((await calls()).length - before, 1); row.deliveryAborted = true;
    } finally { opened.controller.abort(); await opened.reader.cancel().catch(() => {}); }
  });
  if (inlineJob && downloadJob) writeFileSync('/artifacts/media-seed-private.json', JSON.stringify({ caller, inlineJob, downloadJob, videoModel, project }, null, 2) + '\n', { mode: 0o600 });
  evidence.providerCalls = (await calls()).length - beforeAll;
  evidence.pass = evidence.cases.length === 29 && evidence.cases.every(row => row.pass);
  save('media-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
