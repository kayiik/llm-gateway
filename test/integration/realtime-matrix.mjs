import assert from 'node:assert/strict';
import { connectWebsocket, websocketEvent } from './websocket-fixture.mjs';
import { realtimeOffer, realtimeAnswer, realtimeClientText, realtimeServerText, realtimeClientBytes, realtimeServerBytes, geminiInput, geminiOutput } from './realtime-fixture.mjs';
import { primeCallerCatalog } from './catalog-prime.mjs';

const geminiSession = () => ({ type: 'session.update', session: { type: 'realtime', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null }, output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'Puck' } }, output_modalities: ['audio'], tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } }] } });

export async function runRealtimeMatrix({ admin, request, publicCall, metrics, save }) {
  const evidence = { boundary: 'Installed native SDP/WebSocket and declared manual Gemini PCM24k profile; no real provider or media usage inference', pass: false, cases: [] };
  const test = async (name, run) => {
    const row = { name, pass: false }; evidence.cases.push(row);
    try { await run(row); row.pass = true; } catch (error) { row.error = error.message; }
    finally { save('realtime-matrix.json', evidence); }
  };
  const origin = process.env.REPLAY_ORIGIN;
  const project = await admin('projects', { slug: 'realtime-matrix', name: 'Realtime matrix' });
  const caller = await admin('keys', { project_id: project.id, name: 'Realtime matrix caller', daily_requests: 100 });
  for (const target of ['native', 'fallback', 'bad-handshake', 'bad-protocol', 'bad-extensions', 'bad-upgrade', 'denied', 'hold']) {
    const provider = 'realtime-' + target;
    await admin('providers', { id: provider, registry_id: 'openai', base_url: `http://upstream:18889/realtime/${target}/v1`, api_key: 'fixture-realtime-key', timeout: 2 });
    await admin(`providers/${provider}/refresh`, {});
    await primeCallerCatalog({ admin, request, metrics, caller, provider, alias: 'voice-model' });
  }
  await admin('providers', { id: 'realtime-studio', type: 'ai_studio', base_url: 'http://upstream:18889/v1beta', api_key: 'fixture-realtime-key', timeout: 2 });
  for (const [name, first, ingress] of [['realtime-calls-route', 'native', '/v1/realtime/calls'], ['realtime-denied-route', 'denied', '/v1/realtime/calls'], ['realtime-ws-route', 'native', '/v1/realtime'], ['realtime-hold-route', 'hold', '/v1/realtime']]) await admin('endpoints', { name, ingress: [ingress], failover: [{ provider: 'realtime-' + first, model: 'voice-model' }, { provider: 'realtime-fallback', model: 'voice-model' }] });
  const total = async () => { const state = (await metrics()).realtime; return (state?.http.length ?? 0) + (state?.upgrades.length ?? 0); };
  const ws = (model, token = caller.token, extra = {}, path = '/v1/realtime') => connectWebsocket(origin + path + '?model=' + encodeURIComponent(model), { Authorization: 'Bearer ' + token, 'OpenAI-Beta': 'realtime=v1', Cookie: 'fixture-client=must-not-forward', 'X-Api-Key': token, ...extra });
  const form = (model, extra = []) => {
    const body = new FormData(); body.set('sdp', realtimeOffer);
    body.set('session', `{"type":"realtime","model":${JSON.stringify(model)},"instructions":"retain <caller> instructions","provider_number":9007199254740993,"audio":{"output":{"voice":"marin"}},"tools":[{"type":"function","name":"fixture","parameters":{"type":"object"}}]}`);
    for (const [name, value] of extra) body.append(name, value); return body;
  };
  const successfulRequests = [];
  for (const [name, model, path] of [['direct', 'realtime-native/voice-model', '/v1/realtime/calls'], ['route', 'realtime-calls-route', '/v1/realtime/calls'], ['alias', 'realtime-native/voice-model', '/realtime/calls']]) await test('native-webrtc-' + name, async row => {
    const before = (await metrics()).realtime?.http.length ?? 0;
    const response = await publicCall('realtime-webrtc-' + name, path, form(model), caller.token);
    assert.equal(response.status, 201, response.text); assert.equal(response.text, realtimeAnswer); assert.match(response.contentType, /^application\/sdp/);
    assert.equal(response.headers.location, '/v1/realtime/calls/rtc_fixture'); assert.equal(response.headers['x-llmgw-usage-scope'], 'signaling'); assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual((await metrics()).realtime.http.slice(before).map(item => item.target), ['native']); successfulRequests.push(response.requestId); row.upstreamCalls = 1;
  });
  await test('native-webrtc-terminal-refusal-never-replays-or-falls-over', async row => {
    const before = (await metrics()).realtime.http.length;
    const response = await publicCall('realtime-denied', '/v1/realtime/calls', form('realtime-denied-route'), caller.token);
    assert.equal(response.status, 401, response.text); assert.ok(!response.text.includes('fixture-realtime-key'));
    assert.deepEqual((await metrics()).realtime.http.slice(before).map(item => item.target), ['denied']); row.upstreamCalls = 1;
  });
  await test('webrtc-invalid-multipart-session-and-unauthorized-keys-stop-before-io', async row => {
    const before = await total();
    for (const [name, body] of [['duplicate', form('realtime-native/voice-model', [['sdp', 'duplicate']])], ['extra', form('realtime-native/voice-model', [['unexpected', 'value']])], ['bad-session', (() => { const value = form('realtime-native/voice-model'); value.set('session', '{'); return value; })()]]) {
      const response = await publicCall('realtime-invalid-' + name, '/v1/realtime/calls', body, caller.token); assert.equal(response.status, 400, response.text);
    }
    for (const token of ['', 'fixture-invalid-realtime-token']) { const response = await request('/v1/realtime/calls', form('realtime-native/voice-model'), token); assert.equal(response.status, 401, response.text); }
    assert.equal(await total(), before); row.localRefusals = 5;
  });
  await test('realtime-key-provider-policy-refuses-before-signaling', async () => {
    const key = await admin('keys', { project_id: project.id, name: 'Realtime restricted provider', allowed_providers: ['realtime-fallback'] });
    const before = await total(); const response = await publicCall('realtime-provider-policy', '/v1/realtime/calls', form('realtime-native/voice-model'), key.token);
    assert.equal(response.status, 403, response.text); assert.equal(await total(), before);
  });
  for (const [name, model, path] of [['direct', 'realtime-native/voice-model', '/v1/realtime'], ['route', 'realtime-ws-route', '/v1/realtime'], ['alias', 'realtime-native/voice-model', '/realtime']]) await test('native-websocket-text-binary-ping-close-' + name, async row => {
    const before = (await metrics()).realtime?.upgrades.length ?? 0; const connection = await ws(model, caller.token, { 'X-Request-ID': 'realtime-ws-' + name }, path);
    try {
      assert.equal(connection.status, 101, connection.text); assert.equal(connection.headers['set-cookie'], undefined); assert.equal(connection.headers['x-llmgw-usage-scope'], 'unobserved_session');
      connection.send(1, realtimeClientText); connection.send(2, realtimeClientBytes);
      const text = await connection.reader.next(); assert.equal(text.opcode, 1); assert.equal(text.masked, false); assert.equal(text.payload.toString(), realtimeServerText);
      const binary = await connection.reader.next(); assert.equal(binary.opcode, 2); assert.deepEqual(binary.payload, realtimeServerBytes);
      const ping = await connection.reader.next(); assert.equal(ping.opcode, 9); assert.equal(ping.payload.toString(), 'ping'); connection.send(10, ping.payload);
      const close = await connection.reader.next(); assert.equal(close.opcode, 8); connection.send(8, close.payload);
      for (let attempt = 0; attempt < 40 && !(await metrics()).realtime.upgrades.at(-1).closed; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      const actual = (await metrics()).realtime.upgrades.slice(before); assert.equal(actual.length, 1); assert.equal(actual[0].nativeFramesValidated, true); assert.equal(actual[0].cleanClose, true);
      successfulRequests.push('realtime-ws-' + name); row.nativeFrameTypes = [1, 2, 9, 10, 8];
    } finally { connection.close(); }
  });
  for (const target of ['bad-handshake', 'bad-protocol', 'bad-extensions', 'bad-upgrade', 'denied']) await test('native-websocket-refuses-' + target + '-without-replay', async row => {
    const before = (await metrics()).realtime.upgrades.length; const connection = await ws('realtime-' + target + '/voice-model');
    try { assert.equal(connection.status, target === 'denied' ? 401 : 502, connection.text); assert.ok(!connection.text.includes('fixture-realtime-key')); assert.equal((await metrics()).realtime.upgrades.length, before + 1); row.upstreamCalls = 1; }
    finally { connection.close(); }
  });
  await test('native-websocket-caller-close-ends-single-upstream-without-fallback', async row => {
    const before = (await metrics()).realtime.upgrades.length; const connection = await ws('realtime-hold-route'); assert.equal(connection.status, 101, connection.text); connection.close();
    for (let attempt = 0; attempt < 40 && !(await metrics()).realtime.upgrades.at(-1).closed; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    const actual = (await metrics()).realtime.upgrades.slice(before); assert.equal(actual.length, 1); assert.equal(actual[0].target, 'hold'); assert.equal(actual[0].closed, true); row.upstreamClosed = true;
  });
  await test('websocket-auth-and-malformed-upgrade-stop-before-upstream', async row => {
    const before = await total();
    for (const [token, headers, status] of [['fixture-invalid-realtime-token', {}, 401], [caller.token, { 'X-Api-Key': 'fixture-invalid-alternate-key' }, 401], [caller.token, { 'Sec-WebSocket-Version': '12' }, 400], [caller.token, { 'Sec-WebSocket-Key': 'invalid' }, 400]]) {
      const connection = await ws('realtime-native/voice-model', token, headers); try { assert.equal(connection.status, status, connection.text); } finally { connection.close(); }
    }
    assert.equal(await total(), before); row.localRefusals = 4;
  });
  await test('signaling-and-native-websocket-usage-never-invent-session-tokens', async row => {
    let rows = [];
    for (let attempt = 0; attempt < 40; attempt++) { const value = await admin('requests?project_id=' + project.id + '&limit=200'); rows = value.requests ?? value.rows ?? value; if (successfulRequests.every(id => rows.some(item => item.request_id === id))) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    for (const id of successfulRequests) {
      const entries = rows.filter(item => item.request_id === id); assert.equal(entries.length, 1, id);
      const entry = entries[0]; assert.equal(entry.input_tokens, 0); assert.equal(entry.output_tokens, 0);
      assert.equal(entry.source_usage.input_basis, 'unobserved_session'); assert.equal(entry.source_usage.output_basis, 'unobserved_session'); assert.equal(entry.source_usage.input_incomplete, true); assert.equal(entry.source_usage.output_incomplete, true);
      assert.equal(entry.source_usage.selected_attempt, -1); assert.equal(entry.source_usage.selection_unavailable, true); assert.equal(entry.source_usage.attempts.length, 1); assert.equal(entry.source_usage.attempts[0].quality, 'unknown');
    }
    assert.equal(successfulRequests.length, 6); row.observedSignalingRows = successfulRequests.length;
  });
  await test('gemini-setup-ack-pcm-tools-and-interruption-use-one-native-session', async row => {
    const before = (await metrics()).realtime?.upgrades.length ?? 0;
    const connection = await ws('realtime-studio/fixture-live', caller.token, { 'X-LLMGW-Compatibility': 'allow', 'X-Request-ID': 'realtime-gemini-manual' });
    const seen = [];
    try {
      assert.equal(connection.status, 101, connection.text); assert.equal(connection.headers['x-llmgw-usage-scope'], 'unobserved_session');
      assert.ok(connection.headers['x-llmgw-realtime-profile'], 'the bounded profile must identify itself'); row.profile = connection.headers['x-llmgw-realtime-profile'];
      await websocketEvent(connection, 'session.created', seen); connection.json(geminiSession());
      for (let attempt = 0; attempt < 40 && !(await metrics()).realtime.gemini.setupReceived; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal((await metrics()).realtime.gemini.setupReceived, true); assert.equal(await connection.reader.tryNext(100), null, 'session.updated must wait for the actual setup acknowledgement');
      const released = await fetch('http://127.0.0.1:18889/realtime/control/setup-release', { method: 'POST', signal: AbortSignal.timeout(2000) }); assert.equal((await released.json()).released, true);
      await websocketEvent(connection, 'session.updated', seen);
      const turn = () => { for (const bytes of [geminiInput.subarray(0, 2), geminiInput.subarray(2, 14), geminiInput.subarray(14)]) connection.json({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') }); connection.json({ type: 'input_audio_buffer.commit' }); connection.json({ type: 'response.create' }); };
      const audio = async () => { const event = await websocketEvent(connection, 'response.output_audio.delta', seen); assert.deepEqual(Buffer.from(event.delta, 'base64'), geminiOutput); };
      turn(); await audio(); await websocketEvent(connection, 'response.done', seen);
      turn(); await audio(); connection.json({ type: 'response.cancel' });
      for (;;) { const frame = await connection.reader.next(); const event = JSON.parse(frame.payload); seen.push(event); assert.ok(!['response.output_audio.delta', 'error'].includes(event.type), 'late cancelled audio must be fenced'); if (event.type === 'response.done') { assert.equal(event.response.status, 'cancelled'); break; } }
      turn(); const call = await websocketEvent(connection, 'response.function_call_arguments.done', seen); assert.equal(call.call_id, 'fixture-call'); assert.equal(call.arguments, '{"count":9007199254740993}'); await websocketEvent(connection, 'response.done', seen);
      const priorTools = (await metrics()).realtime.gemini.toolResults;
      connection.json({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'unrelated-call', output: 'must-not-send' } }); await websocketEvent(connection, 'error', seen); assert.equal((await metrics()).realtime.gemini.toolResults, priorTools);
      connection.json({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'fixture-call', output: 'fixture-result' } }); connection.json({ type: 'response.create' }); await audio(); await websocketEvent(connection, 'response.done', seen);
      const actual = (await metrics()).realtime; assert.equal(actual.upgrades.length - before, 1); assert.equal(actual.gemini.turns, 3); assert.equal(actual.gemini.toolResults, 1); assert.equal(actual.gemini.interruptions, 1); assert.equal(actual.gemini.activities, 3); row.pcmBytesPerTurn = geminiInput.length; row.outputBytes = geminiOutput.length; row.nativeSessions = 1;
      connection.json({ type: 'conversation.item.truncate', item_id: 'fixture-item', content_index: 0, audio_end_ms: 20 }); await websocketEvent(connection, 'error', seen);
      assert.equal((await metrics()).realtime.gemini.turns, 3, 'unsupported accurate-heard truncation must not invent another native turn');
    } finally { connection.close(); }
  });
  await test('gemini-session-close-keeps-usage-unobserved', async row => {
    let entry;
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = await admin('requests?request_id=realtime-gemini-manual'); const rows = value.requests ?? value.rows ?? value; entry = rows[0];
      if (entry) break; await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(entry); assert.equal(entry.input_tokens, 0); assert.equal(entry.output_tokens, 0);
    assert.equal(entry.source_usage.input_basis, 'unobserved_session'); assert.equal(entry.source_usage.output_basis, 'unobserved_session');
    assert.equal(entry.source_usage.input_incomplete, true); assert.equal(entry.source_usage.output_incomplete, true); row.observedSessionTokens = false;
  });
  for (const [name, change] of [
    ['wrong-rate', session => { session.audio.input.format.rate = 16000; }],
    ['server-vad', session => { session.audio.input.turn_detection = { type: 'server_vad' }; }],
    ['wrong-codec', session => { session.audio.output.format.type = 'audio/pcmu'; }],
    ['unknown-voice', session => { session.audio.output.voice = 'unsupported-fixture-voice'; }],
    ['truncation', session => { session.truncation = 'auto'; }],
  ]) await test('gemini-refuses-' + name + '-before-native-setup-or-generation', async row => {
    const before = structuredClone((await metrics()).realtime.gemini); const beforeConnections = await total(); const connection = await ws('realtime-studio/fixture-live', caller.token, { 'X-LLMGW-Compatibility': 'allow' });
    try {
      assert.equal(connection.status, 101, connection.text); await websocketEvent(connection, 'session.created'); const event = geminiSession(); change(event.session); connection.json(event); await websocketEvent(connection, 'error');
      const after = (await metrics()).realtime.gemini;
      assert.equal(after.setups, before.setups); assert.equal(after.turns, before.turns); assert.equal(after.toolResults, before.toolResults);
      assert.equal(await total(), beforeConnections + 1, 'the admitted session must not reconnect'); row.nativeConnections = 1; row.nativeSetups = 0; row.nativeGenerations = 0;
    }
    finally { connection.close(); }
  });
  const rejected = (await metrics()).realtime?.rejected ?? 0;
  evidence.fixtureRejections = rejected; evidence.pass = evidence.cases.length === 24 && rejected === 0 && evidence.cases.every(row => row.pass);
  save('realtime-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
