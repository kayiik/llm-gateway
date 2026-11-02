import assert from 'node:assert/strict';

export const mediaPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F9kAAAAASUVORK5CYII=', 'base64');
export const mediaMP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 109, 112, 52, 49]);
export const mediaWAV = (() => {
  const body = Buffer.alloc(60); body.write('RIFF'); body.writeUInt32LE(52, 4); body.write('WAVEfmt ', 8); body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22); body.writeUInt32LE(8000, 24); body.writeUInt32LE(16000, 28);
  body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34); body.write('data', 36); body.writeUInt32LE(16, 40); return body;
})();
const vector = text => ({ first: [0.125, -0.25, 0.5], second: [-0.5, 0.625, 0.75], hello: [0.125, -0.25, 0.5] })[text];
const tokenCount = text => text === 'second' ? 5 : 3;

export function createMediaFixture(metrics) {
  const releases = new Map();
  const heldJobPolls = new Set();
  return async (req, res, path) => {
    const match = path.match(/^\/media\/([a-z-]+)\/v1\/(.*)$/);
    if (!match) return false;
    const target = match[1], tail = match[2];
    const state = metrics.media ??= { catalogs: [], calls: [], rejected: 0 };
    const google = target.startsWith('studio') || target === 'vertex';
    const origin = 'http://' + req.headers.host;
    res.setHeader('Content-Type', 'application/json');
    if (tail === 'control/release' && req.method === 'POST') { const release = releases.get(target); release?.(); res.end(JSON.stringify({ released: !!release })); return true; }
    if (req.method === 'GET' && (tail === 'models' || tail === 'publishers/google/models')) {
      state.catalogs.push({ target, page: new URL(req.url, origin).searchParams.get('pageToken') });
      if (google) {
        const page = new URL(req.url, origin).searchParams.get('pageToken');
        const models = page ? [
          { name: 'models/veo-3.0-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
          { name: 'models/veo-3.0-generate-002', supportedGenerationMethods: ['predictLongRunning'] },
          { name: 'models/legacy-unsupported', supportedGenerationMethods: ['generateMessage'] },
        ] : [
          { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent', 'batchEmbedContents'] },
          { name: 'models/text-embedding-005', supportedGenerationMethods: ['predict'] },
        ];
        res.end(JSON.stringify({ models, ...(page ? {} : { nextPageToken: 'page-2' }) })); return true;
      }
      const id = target === 'siliconflow' ? 'Qwen/Qwen3-Embedding-0.6B' : 'fixture-speech';
      res.end(JSON.stringify({ data: [{ id, supported_endpoints: [target === 'siliconflow' ? '/embeddings' : '/audio/speech'] }] })); return true;
    }
    const file = tail.match(/^files\/([^/]+):download$/);
    const modelAction = tail.match(/(?:^|\/)models\/([^/:]+):([a-zA-Z]+)$/);
    const operation = tail.match(/(?:^|\/)models\/([^/]+)\/operations\/(job-[a-z-]+)$/);
    const polling = !!operation || modelAction?.[2] === 'fetchPredictOperation';
    const kind = file ? 'file' : polling ? 'video-poll' : modelAction?.[2] === 'countTokens' ? 'count' : modelAction?.[2] === 'predictLongRunning' ? 'video-start' : modelAction?.[2] === 'embedContent' || modelAction?.[2] === 'batchEmbedContents' || modelAction?.[2] === 'predict' || tail === 'embeddings' ? 'embedding' : modelAction?.[1].includes('-image') ? 'image' : tail === 'audio/speech' ? 'speech' : 'chat';
    const call = { target, kind, path: tail, host: req.headers.host };
    state.calls.push(call);
    if (!polling && !file && kind !== 'count') metrics.inference++;
    let raw = ''; for await (const part of req) raw += part;
    try {
      assert.equal(google ? req.headers['x-goog-api-key'] : req.headers.authorization, google ? 'fixture-media-key' : 'Bearer fixture-media-key');
      if (file) {
        assert.equal(req.headers.accept, 'video/mp4');
        if (file[1] === 'job-redirect') { res.writeHead(302, { Location: `http://untrusted:${new URL(origin).port}/media/${target}/v1/files/credential-leak:download` }); res.end(); return true; }
        res.setHeader('Content-Type', file[1] === 'job-wrong-mime' ? 'text/html' : 'video/mp4');
        res.end(file[1] === 'job-invalid-video' ? Buffer.from('not an mp4') : mediaMP4); return true;
      }
      const body = raw ? JSON.parse(raw) : {};
      if (kind === 'count') { assert.ok(Array.isArray(body.contents)); res.end('{"totalTokens":3}'); return true; }
      if (google && target === 'vertex' && modelAction) assert.match(tail, /^projects\/fixture-project\/locations\/global\/publishers\/google\/models\//);
      if (target.endsWith('-error')) { res.writeHead(401); res.end('{"error":{"status":"UNAUTHENTICATED","message":"Controlled media credential rejection."}}'); return true; }
      if (kind === 'embedding') {
        if (target === 'siliconflow') {
          assert.equal(body.model, 'Qwen/Qwen3-Embedding-0.6B'); assert.equal(body.input, 'hello'); assert.equal(body.encoding_format, 'float');
          res.end(JSON.stringify({ object: 'list', model: body.model, data: [{ object: 'embedding', index: 0, embedding: vector('hello') }], usage: { prompt_tokens: 3, total_tokens: 3 } })); return true;
        }
        const text = value => value?.parts?.map(part => part.text ?? '').join('') ?? '';
        if (modelAction[2] === 'predict') {
          assert.equal(modelAction[1], 'text-embedding-005');
          const values = body.instances.map(item => item.content); values.forEach(value => assert.ok(vector(value)));
          call.inputs = values;
          res.end(JSON.stringify({ predictions: values.map(value => ({ embeddings: { values: vector(value), statistics: { token_count: tokenCount(value) } } })) })); return true;
        }
        const values = modelAction[2] === 'batchEmbedContents' ? body.requests.map(item => text(item.content)) : [text(body.content)];
        values.forEach(value => assert.ok(vector(value))); call.inputs = values;
        res.end(JSON.stringify(modelAction[2] === 'batchEmbedContents' ? { embeddings: values.map(value => ({ values: vector(value) })) } : { embedding: { values: vector(values[0]) } })); return true;
      }
      if (kind === 'image') {
        const prompt = body.contents?.flatMap(item => item.parts ?? []).map(part => part.text ?? '').join('');
        assert.ok(['an origami crane', 'unsafe image', 'empty image'].includes(prompt));
        assert.ok(body.generationConfig?.responseModalities.includes('IMAGE'));
        const parts = prompt === 'empty image' ? [] : [{ inlineData: { mimeType: prompt === 'unsafe image' ? 'image/svg+xml' : 'image/png', data: (prompt === 'unsafe image' ? Buffer.from('<svg onload="invalid()"/>') : mediaPNG).toString('base64') } }];
        res.end(JSON.stringify({ candidates: [{ content: { parts } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1120, totalTokenCount: 1123, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }] } })); return true;
      }
      if (kind === 'video-start') {
        const prompt = body.instances?.[0]?.prompt;
        call.promptShape = typeof prompt; call.promptValue = typeof prompt === 'string' ? prompt.slice(0, 60) : ''; call.requestFields = Object.keys(body).sort(); call.sampleCount = body.parameters?.sampleCount; call.resolution = body.parameters?.resolution;
        assert.ok(['inline', 'download', 'cross', 'redirect', 'wrong-mime', 'invalid-video', 'held'].includes(prompt));
        assert.equal(body.parameters?.sampleCount, 1);
        assert.ok(body.parameters?.resolution === undefined || body.parameters?.resolution === '720p', 'a provided resolution must remain 720p; the browser may leave it unspecified');
        const name = target === 'vertex' ? tail.replace(':predictLongRunning', '') + '/operations/job-' + prompt : 'operations/job-' + prompt;
        res.end(JSON.stringify({ name })); return true;
      }
      if (kind === 'video-poll') {
        const name = operation?.[2] ?? body.operationName?.split('/').at(-1);
        assert.ok(name?.startsWith('job-'));
        if (modelAction?.[2] === 'fetchPredictOperation') assert.match(body.operationName, /^projects\/fixture-project\/locations\/global\/publishers\/google\/models\/veo-3\.0-generate-001\/operations\//);
        if (name === 'job-held' && !heldJobPolls.has(name)) {
          heldJobPolls.add(name);
          await new Promise(resolve => {
            const finish = () => { clearTimeout(timer); releases.delete(target); resolve(); };
            const timer = setTimeout(finish, 10000); releases.set(target, finish); res.once('close', finish);
          });
          if (res.destroyed) { call.cancelled = true; return true; }
        }
        if (name === 'job-inline') { res.end(JSON.stringify({ done: true, response: { videos: [{ bytesBase64Encoded: mediaMP4.toString('base64'), mimeType: 'video/mp4' }] } })); return true; }
        const host = name === 'job-cross' ? `http://untrusted:${new URL(origin).port}` : origin;
        res.end(JSON.stringify({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${host}/media/${target}/v1/files/${name}:download` } }] } } })); return true;
      }
      if (kind === 'speech') {
        assert.equal(body.model, 'fixture-speech'); assert.equal(body.input, 'Hello.'); assert.equal(body.voice, 'fixture-voice'); assert.equal(body.response_format, 'wav');
        if (target === 'speech-redirect') { res.writeHead(302, { Location: '/media/speech-next/v1/audio/speech' }); res.end(); return true; }
        res.setHeader('Content-Type', 'audio/wav');
        if (target === 'speech-stream' || target === 'speech-truncated') {
          assert.equal(body.stream, true);
          res.write(mediaWAV.subarray(0, 44));
          await new Promise(resolve => {
            const finish = () => { clearTimeout(timer); releases.delete(target); resolve(); };
            const timer = setTimeout(finish, 10000); releases.set(target, finish); res.once('close', finish);
          });
          if (res.destroyed) { call.cancelled = true; return true; }
          if (target === 'speech-truncated') { res.destroy(); return true; }
          call.completed = true; res.end(mediaWAV.subarray(44)); return true;
        }
        res.end(mediaWAV); return true;
      }
      assert.equal(modelAction?.[2], 'generateContent');
      res.end('{"candidates":[{"content":{"role":"model","parts":[{"text":"Google fixture"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}'); return true;
    } catch (error) {
      call.fixtureAssertionLine = Number(error?.stack?.match(/media-fixture\.mjs:(\d+)/)?.[1] ?? 0);
      state.rejected++; res.writeHead(422); res.end('{"error":{"message":"Controlled media request mismatch."}}'); return true;
    }
  };
}
