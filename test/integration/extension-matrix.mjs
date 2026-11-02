import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { ensureOwnerFixture, ownerRequest } from '../qualification/owner-fixture.mjs';
import { primeCallerCatalog } from './catalog-prime.mjs';
import { mediaWAV } from './media-fixture.mjs';
import { conversation } from './fake-upstream.mjs';

export async function runExtensionMatrix({ admin, request, publicCall, metrics, save, registerSecret }) {
  const origin = process.env.REPLAY_ORIGIN, adminKey = process.env.REPLAY_ADMIN_KEY, ssoSecret = process.env.REPLAY_SSO_SECRET;
  const owners = await ensureOwnerFixture({ origin, adminKey, ssoSecret });
  for (const token of ['fixture-extension-secret', 'fixture-extension-owner-token', 'fixture-extension-shared-token', 'fixture-extension-refresh', owners.keys.a.token, owners.keys.b.token]) registerSecret(token);
  const evidence = { boundary: 'Installed Gateway saved daemon, discovery, typed declarations, ordinary capabilities and owned OAuth flow state; controlled provider implementation', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; evidence.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('extension-matrix.json', evidence); } };
  const daemon = owners.extension ?? await admin('extensions', { id: 'qualification-daemon', name: 'Qualification daemon', url: 'http://upstream:18889/daemon', secret: 'fixture-extension-secret' });
  const id = daemon.id; assert.ok(id);
  for (const [instance, type] of [['ext-declared', 'fixture_declared'], ['ext-nonstream', 'google_antigravity'], ['ext-oauth-alt', 'fixture_oauth_alt'], ['ext-copilot', 'github_copilot']]) await admin('providers', { id: instance, type, extension: id });
  for (const provider of ['ext-declared', 'ext-nonstream']) await admin('providers/' + provider + '/refresh', {});
  const project = await admin('projects', { slug: 'extension-matrix', name: 'Extension matrix' });
  const caller = await admin('keys', { project_id: project.id, name: 'Extension declared capability caller', daily_requests: 100 });
  await primeCallerCatalog({ admin, request, metrics, caller, provider: 'ext-declared', alias: 'chat-only' });
  await primeCallerCatalog({ admin, request, metrics, caller, provider: 'ext-nonstream', alias: 'nonstream-chat' });
  const calls = async () => (await metrics()).extension?.calls ?? [];
  const user = (actor, provider, operation, body) => ownerRequest({ origin, ssoSecret, actor, path: `/user/api/connections/${provider}/oauth/${operation}`, body, registerSecret });
  const mode = async value => { const response = await fetch('http://127.0.0.1:18889/daemon/control/expiry', { method: 'POST', body: JSON.stringify({ mode: value }), signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); await response.json(); };
  const payload = (wire, model, stream = false) => wire === 'responses' ? { model, input: 'extension text', stream } : { model, messages: [{ role: 'user', content: 'extension text' }], stream, ...(wire === 'messages' ? { max_tokens: 32 } : {}) };
  await test('saved-daemon-check-reports-exact-facts-without-secret-echo', async row => {
    const checked = await admin('extensions/' + id + '/check', {}); assert.equal(checked.reachable, true); assert.equal(checked.version, '0.0.4'); assert.equal(checked.unauthenticated, false);
    const listing = await admin('extensions'); const record = listing.extensions.find(item => item.id === id); assert.equal(record.secret_set, true); assert.equal(record.url, 'http://upstream:18889/daemon'); assert.ok(!JSON.stringify(listing).includes('fixture-extension-secret')); row.version = checked.version;
  });
  await test('wrong-secret-and-unavailable-daemon-remain-distinct-safe-failures', async row => {
    for (const [url, secret, code] of [['http://upstream:18889/daemon', 'wrong-fixture-secret', 'secret_refused'], ['http://upstream:1', 'fixture-extension-secret', 'no_answer']]) {
      const checked = await admin('extensions/check', { url, secret }); assert.equal(checked.reachable, false); assert.equal(checked.error_code, code); assert.ok(!JSON.stringify(checked).includes(secret));
    }
    row.failureClasses = ['secret_refused', 'no_answer'];
  });
  await test('undeclared-provider-and-in-use-removal-refuse-without-mutation', async row => {
    const before = (await admin('state')).providers.map(item => item.id).sort();
    const invalid = await request('/admin/api/providers', { id: 'ext-undeclared', type: 'not_advertised', extension: id }); assert.equal(invalid.status, 400, invalid.text); assert.deepEqual((await admin('state')).providers.map(item => item.id).sort(), before);
    const response = await fetch(origin + '/admin/api/extensions/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminKey }, signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 409, await response.text()); assert.ok((await admin('extensions')).extensions.some(item => item.id === id)); row.savedBindingRetained = true;
  });
  await test('model-specific-api-declarations-do-not-inherit-provider-wide-surfaces', async row => {
    const response = await request('/v1/models', undefined, caller.token); assert.equal(response.status, 200); const rows = JSON.parse(response.text).data; save('extension-public-catalog.json', JSON.parse(response.text));
    for (const [model, native] of [['chat-only', '/v1/chat/completions'], ['responses-only', '/v1/responses'], ['messages-only', '/v1/messages']]) {
      const found = rows.find(item => item.id === 'ext-declared/' + model); assert.ok(found, model + ' must be discoverable');
      assert.deepEqual(found.native_surfaces, [native], 'model-specific native APIs must not expand to every provider surface');
      assert.deepEqual(found.supported_endpoints, [native]);
      row[model] = { native_apis: found.native_apis ?? found.native_surfaces, supported_apis: found.supported_apis ?? found.supported_endpoints };
    }
    const unknown = rows.find(item => item.id === 'ext-declared/unknown-model'); assert.ok(unknown); assert.deepEqual(unknown.native_surfaces ?? [], []); assert.deepEqual(unknown.supported_endpoints ?? [], []); row.exactModelRows = 4;
  });
  for (const [wire, path, model] of [['chat', '/v1/chat/completions', 'chat-only'], ['responses', '/v1/responses', 'responses-only'], ['messages', '/v1/messages', 'messages-only']]) for (const stream of [false, true]) await test('declared-native-' + wire + (stream ? '-sse' : '-json'), async row => {
    const before = (await calls()).length; const response = await publicCall('extension-native-' + wire + '-' + stream, path, payload(wire, 'ext-declared/' + model, stream), caller.token);
    assert.equal(response.status, 200, response.text); assert.match(response.contentType, stream ? /text\/event-stream/ : /application\/json/);
    if (stream) assert.match(response.text, wire === 'chat' ? /\[DONE\]/ : wire === 'messages' ? /message_stop/ : /response.completed/);
    else assert.ok(response.text.includes('complete-fixture'));
    const actual = (await calls()).slice(before); assert.equal(actual.length, 1); assert.equal(actual[0].surface, { chat: 'chat_completions', responses: 'responses', messages: 'messages' }[wire]); assert.equal(actual[0].model, model); row.nativeCalls = 1;
  });
  await test('native-responses-and-explicit-chat-projection-remain-distinct', async row => {
    const before = (await calls()).length;
    const denied = await publicCall('extension-chat-denied', '/v1/chat/completions', payload('chat', 'ext-declared/responses-only'), caller.token); assert.equal(denied.status, 400, denied.text); assert.equal((await calls()).length, before);
    const allowed = await publicCall('extension-chat-projected', '/v1/chat/completions', payload('chat', 'ext-declared/responses-only'), caller.token, 'allow'); assert.equal(allowed.status, 200, allowed.text); assert.equal(JSON.parse(allowed.text).choices[0].message.content, 'complete-fixture');
    assert.deepEqual((await calls()).slice(before).map(item => item.surface), ['responses']); row.projectedNativeAPI = 'responses';
  });
  await test('known-nonnative-and-undeclared-media-cannot-dispatch', async row => {
    const before = (await calls()).length;
    const denied = await publicCall('extension-undeclared-responses', '/v1/responses', payload('responses', 'ext-declared/chat-only'), caller.token); assert.equal(denied.status, 400, denied.text);
    const embedding = await publicCall('extension-undeclared-embedding', '/v1/embeddings', { model: 'ext-declared/chat-only', input: 'hello' }, caller.token); assert.equal(embedding.status, 400, embedding.text);
    const image = await publicCall('extension-undeclared-image', '/v1/images/generations', { model: 'ext-declared/unknown-model', prompt: 'must-not-dispatch' }, caller.token); assert.equal(image.status, 400, image.text);
    assert.equal((await calls()).length, before); row.refusals = 3;
  });
  await test('antigravity-like-nonstream-chat-serves-json-and-refuses-stream-before-io', async row => {
    const before = (await calls()).length;
    const response = await publicCall('extension-nonstream-chat', '/v1/chat/completions', payload('chat', 'ext-nonstream/nonstream-chat'), caller.token); assert.equal(response.status, 200, response.text); assert.equal(JSON.parse(response.text).choices[0].message.content, 'complete-fixture');
    const blocked = await publicCall('extension-nonstream-refusal', '/v1/chat/completions', payload('chat', 'ext-nonstream/nonstream-chat', true), caller.token); assert.equal(blocked.status, 400, blocked.text); assert.equal((await calls()).length, before + 1); row.streamRefusedBeforeDispatch = true;
  });
  await test('a-count-method-without-daemon-count-surface-stays-a-marked-estimate', async row => {
    const before = (await calls()).length;
    const response = await request('/v1/messages/count_tokens', { model: 'ext-declared/chat-only', messages: [{ role: 'user', content: 'count' }] }, caller.token);
    assert.equal(response.status, 200, response.text); assert.equal(response.headers['x-llmgw-token-count'], 'estimate'); assert.equal((await calls()).length, before); row.daemonCountCalls = 0;
  });
  await test('declared-extension-speech-preserves-model-voice-input-and-bytes', async row => {
    const before = (await calls()).length;
    const response = await publicCall('extension-speech', '/v1/audio/speech', { model: 'ext-declared/voice', input: 'Hello.', voice: 'fixture-voice', response_format: 'wav' }, caller.token);
    assert.equal(response.status, 200, response.text); assert.deepEqual(Buffer.from(response.bodyBase64, 'base64'), mediaWAV);
    const actual = (await calls()).slice(before); assert.equal(actual.length, 1); assert.equal(actual[0].surface, 'audio_speech'); assert.equal(actual[0].model, 'voice'); row.audioBytes = mediaWAV.length;
  });
  const signIn = async (name, expiry, { testOwnership = false, provider = 'ext-browser-oauth' } = {}) => {
    await mode(expiry); const started = await user('a', provider, 'start', { flow: 'device_code', connection_name: name }); assert.equal(started.status, 200, started.text);
    const code = started.json.device_code; assert.ok(code); registerSecret(code);
    if (testOwnership) {
      const before = (await metrics()).extension.oauthPolls;
      const foreign = await user('b', 'ext-browser-oauth', 'poll', { device_code: code, connection_name: name }); assert.equal(foreign.json.status, 'expired', 'foreign flow existence remains private');
      const wrong = await user('a', 'ext-oauth-alt', 'poll', { device_code: code, connection_name: name }); assert.equal(wrong.json.status, 'expired');
      assert.equal((await metrics()).extension.oauthPolls, before, 'wrong caller/provider must not consume the flow or contact the daemon');
    }
    let response;
    for (let attempt = 0; attempt < 5; attempt++) {
      response = await user('a', provider, 'poll', { device_code: code, connection_name: name });
      if (response.json?.status !== 'pending' && response.json?.status !== 'authorization_pending') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    response.flowCode = code; return response;
  };
  await test('device-flow-ownership-binding-and-absent-expiry-persist-privately', async row => {
    const authorized = await signIn('extension-absent', 'absent', { testOwnership: true }); assert.equal(authorized.status, 200, authorized.text); assert.equal(authorized.json.status, 'authorized', authorized.text);
    const mine = await ownerRequest({ origin, ssoSecret, actor: 'a', path: '/user/api/connections' }); const connection = mine.json.connections.find(item => item.provider_id === 'ext-browser-oauth' && item.connection_name === 'extension-absent'); assert.ok(connection); assert.ok((connection.expires_at ?? 0) >= 0); assert.ok(!mine.text.includes('fixture-extension-owner-token'));
    const theirs = await ownerRequest({ origin, ssoSecret, actor: 'b', path: '/user/api/connections' }); assert.ok(!theirs.json.connections.some(item => item.id === connection.id));
    const before = (await metrics()).extension.oauthPolls; const consumed = await user('a', 'ext-browser-oauth', 'poll', { device_code: authorized.flowCode, connection_name: 'extension-absent' }); assert.ok(['expired', 'error'].includes(consumed.json.status)); assert.equal((await metrics()).extension.oauthPolls, before, 'an approved consumed flow cannot replay token exchange');
    await admin('providers/ext-browser-oauth/refresh?principal_id=' + owners.actors.a.id, {}); row.privateConnection = connection.id;
  });
  await test('approved-private-oauth-credential-is-not-a-service-or-foreign-human-grant', async row => {
    const before = (await calls()).length;
    const good = await publicCall('extension-private-owner', '/v1/chat/completions', payload('chat', 'ext-browser-oauth/private-chat'), owners.keys.a.token); assert.equal(good.status, 200, good.text); assert.equal((await calls()).at(-1).credential, 'owner');
    for (const token of [owners.keys.b.token, caller.token]) { const blocked = await request('/v1/chat/completions', payload('chat', 'ext-browser-oauth/private-chat'), token); assert.ok([403, 404].includes(blocked.status), blocked.text); }
    assert.equal((await calls()).length, before + 1); row.ownerOnly = true;
  });
  await test('native-extension-responses-tool-output-continues-with-matching-call-id', async row => {
    const model = 'ext-browser-oauth/private-responses', input = [{ role: 'user', content: 'Use the fixture lookup tool' }];
    const tools = [{ type: 'function', name: conversation.tool.name, description: 'Controlled lookup', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }];
    const before = (await calls()).length;
    const first = await publicCall('extension-tool-turn-one', '/v1/responses', { model, input, tools, stream: false }, owners.keys.a.token);
    assert.equal(first.status, 200, first.text); const opened = JSON.parse(first.text);
    const tool = opened.output.find(item => item.type === 'function_call'); assert.ok(tool); assert.equal(tool.call_id, conversation.tool.id); assert.equal(tool.name, conversation.tool.name);
    assert.deepEqual(JSON.parse(tool.arguments), JSON.parse(conversation.tool.arguments)); assert.equal(opened.usage.total_tokens, conversation.usage.initial.total_tokens);
    const continuation = { model, input: [...input, ...opened.output, { type: 'function_call_output', call_id: tool.call_id, output: conversation.tool.result }], tools, stream: false };
    const wrong = structuredClone(continuation); wrong.input.at(-1).call_id = 'unrelated-call';
    const rejected = await publicCall('extension-tool-wrong-call', '/v1/responses', wrong, owners.keys.a.token); assert.equal(rejected.status, 422, rejected.text);
    const second = await publicCall('extension-tool-turn-two', '/v1/responses', continuation, owners.keys.a.token); assert.equal(second.status, 200, second.text);
    const completed = JSON.parse(second.text); assert.equal(completed.output.flatMap(item => item.content ?? []).find(item => item.type === 'output_text')?.text, conversation.text);
    assert.equal(completed.usage.total_tokens, conversation.usage.final.total_tokens);
    assert.deepEqual((await calls()).slice(before).map(item => [item.surface, item.model, item.credential]), Array.from({ length: 3 }, () => ['responses', 'private-responses', 'owner'])); row.actualToolTurns = 2; row.wrongCallRejected = true;
  });
  await test('native-extension-responses-streamed-tool-turns-keep-completed-output-and-usage', async row => {
    const model = 'ext-browser-oauth/private-responses', input = [{ role: 'user', content: 'Use the fixture lookup tool in a stream' }];
    const tools = [{ type: 'function', name: conversation.tool.name, description: 'Controlled lookup', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }];
    const complete = response => {
      assert.equal(response.status, 200, response.text); assert.match(response.contentType, /text\/event-stream/);
      const events = [...response.text.matchAll(/^data: (\{.*\})$/gm)].map(match => JSON.parse(match[1]));
      assert.equal(events.filter(event => event.type === 'response.completed').length, 1, 'one successful terminal per native stream');
      assert.equal(events.some(event => event.type === 'response.failed'), false); return events.find(event => event.type === 'response.completed').response;
    };
    const before = (await calls()).length;
    const first = complete(await publicCall('extension-stream-tool-one', '/v1/responses', { model, input, tools, stream: true }, owners.keys.a.token));
    const tool = first.output.find(item => item.type === 'function_call'); assert.ok(tool); assert.equal(tool.call_id, conversation.tool.id); assert.equal(first.usage.total_tokens, conversation.usage.initial.total_tokens);
    const next = complete(await publicCall('extension-stream-tool-two', '/v1/responses', { model, input: [...input, ...first.output, { type: 'function_call_output', call_id: tool.call_id, output: conversation.tool.result }], tools, stream: true }, owners.keys.a.token));
    assert.equal(next.output.flatMap(item => item.content ?? []).find(item => item.type === 'output_text')?.text, conversation.text);
    assert.equal(next.usage.total_tokens, conversation.usage.final.total_tokens);
    assert.deepEqual((await calls()).slice(before).map(item => [item.operation, item.model, item.credential]), [['stream', 'private-responses', 'owner'], ['stream', 'private-responses', 'owner']]); row.nativeStreamTurns = 2;
  });
  await test('explicit-zero-oauth-expiry-remains-valid-not-negative-unix-time', async row => {
    const authorized = await signIn('extension-zero', 'zero'); assert.equal(authorized.json?.status, 'authorized', authorized.text);
    const listed = await ownerRequest({ origin, ssoSecret, actor: 'a', path: '/user/api/connections' }); const connection = listed.json.connections.find(item => item.connection_name === 'extension-zero'); assert.ok(connection); assert.ok((connection.expires_at ?? 0) >= 0); row.zeroIsValid = true;
  });
  await test('expired-device-flow-never-polls-provider-or-creates-private-state', async row => {
    await mode('expired'); const started = await user('a', 'ext-browser-oauth', 'start', { flow: 'device_code', connection_name: 'extension-expired' }); assert.equal(started.status, 200, started.text); registerSecret(started.json.device_code);
    const before = (await metrics()).extension.oauthPolls; const response = await user('a', 'ext-browser-oauth', 'poll', { device_code: started.json.device_code, connection_name: 'extension-expired' }); assert.equal(response.json.status, 'expired'); assert.equal((await metrics()).extension.oauthPolls, before);
    const listed = await ownerRequest({ origin, ssoSecret, actor: 'a', path: '/user/api/connections' }); assert.ok(!listed.json.connections.some(item => item.connection_name === 'extension-expired')); row.providerPolls = 0;
  });
  for (const bad of ['negative', 'failure']) await test('oauth-' + bad + '-completion-leaves-no-partial-private-state', async row => {
    const response = await signIn('extension-' + bad, bad); assert.ok(response.json?.status !== 'authorized', 'invalid completion cannot claim authorization');
    const listed = await ownerRequest({ origin, ssoSecret, actor: 'a', path: '/user/api/connections' }); assert.ok(!listed.json.connections.some(item => item.connection_name === 'extension-' + bad)); row.partialConnections = 0;
  });
  await test('private-extension-models-do-not-become-global-public-discovery', async row => {
    const global = await request('/v1/models'); assert.equal(global.status, 200); assert.ok(!JSON.parse(global.text).data.some(item => item.id?.startsWith('ext-browser-oauth/'))); row.globalPrivateRows = 0;
  });
  await test('copilot-personal-auth-remains-private-even-with-a-configured-shared-token', async row => {
    const authorized = await signIn('copilot-personal', 'absent', { provider: 'ext-copilot' }); assert.equal(authorized.json?.status, 'authorized', authorized.text);
    await admin('providers/ext-copilot/refresh?principal_id=' + owners.actors.a.id, {});
    const before = (await calls()).length; const response = await publicCall('extension-personal-copilot', '/v1/chat/completions', payload('chat', 'ext-copilot/private-chat'), owners.keys.a.token); assert.equal(response.status, 200, response.text); assert.equal((await calls()).at(-1).credential, 'owner');
    const foreign = await request('/v1/chat/completions', payload('chat', 'ext-copilot/private-chat'), owners.keys.b.token); assert.ok([403, 404].includes(foreign.status), foreign.text); assert.equal((await calls()).length, before + 1); row.privateCredentialSelected = true;
  });
  await test('copilot-service-requires-its-exact-active-project-binding', async row => {
    const model = 'ext-copilot/private-chat'; const before = (await calls()).length;
    const noBinding = await request('/v1/chat/completions', payload('chat', model), caller.token); assert.ok([403, 404].includes(noBinding.status), noBinding.text); assert.equal((await calls()).length, before, 'membership or a legacy token alone is not a service grant');
    const imported = await admin('providers/ext-copilot/shared-credential/import', { source: 'configured' }); const credential = imported.credential; assert.ok(credential.id); assert.ok(!JSON.stringify(imported).includes('fixture-extension-shared-token'));
    await admin(`projects/${project.id}/provider-credential-bindings`, { provider_id: 'ext-copilot', principal_kind: 'service', credential_id: credential.id });
    await primeCallerCatalog({ admin, request, metrics, caller, provider: 'ext-copilot', alias: 'private-chat' });
    const allowed = await publicCall('extension-service-bound-copilot', '/v1/chat/completions', payload('chat', model), caller.token); assert.equal(allowed.status, 200, allowed.text); assert.equal((await calls()).at(-1).credential, 'shared');
    await admin(`projects/${project.id}/provider-credential-bindings/status`, { provider_id: 'ext-copilot', principal_kind: 'service', status: 'disabled' });
    const after = (await calls()).length; const disabled = await request('/v1/chat/completions', payload('chat', model), caller.token); assert.ok([403, 404].includes(disabled.status), disabled.text); assert.equal((await calls()).length, after, 'a stale cached binding cannot outlive deactivation');
    row.exactBindingEnforced = true;
  });
  writeFileSync('/artifacts/extension-seed-private.json', JSON.stringify({ id, owners, caller, project, instance: 'ext-browser-oauth', model: 'private-chat' }, null, 2) + '\n', { mode: 0o600 });
  evidence.fixtureRejections = (await metrics()).extension.rejected;
  evidence.pass = evidence.cases.length === 26 && evidence.cases.every(row => row.pass) && evidence.fixtureRejections === 1;
  save('extension-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
