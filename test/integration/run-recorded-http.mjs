import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstalledState } from '../qualification/installed-state.mjs';
import { runInstalledBrowser } from '../qualification/installed-browser.mjs';
import { runInstalledMediaRecovery } from '../qualification/installed-media.mjs';
import { runInstalledExtensionRecovery } from '../qualification/installed-extension.mjs';
import { runInstalledOperationalRecovery } from '../qualification/installed-operational.mjs';
import { runInstalledMetricsRecovery } from '../qualification/installed-metrics.mjs';
import { runInstalledShutdown, runShutdownClient } from '../qualification/installed-shutdown.mjs';
import { runInstalledRateRecovery } from '../qualification/installed-rate.mjs';
import { runInstalledDiscoveryRecovery } from '../qualification/installed-discovery.mjs';
import { runInstalledTransparentRecovery } from '../qualification/installed-transparent.mjs';
import { runInstalledExternalKeys } from '../qualification/installed-external-keys.mjs';
import { runOwnerBrowser } from '../qualification/owner-browser.mjs';
import { runInstalledClients } from '../qualification/installed-clients.mjs';
import { ownerActors } from '../qualification/owner-fixture.mjs';
import { runStreamingToolMatrix } from './streaming-tool-matrix.mjs';
import { runEmbeddingsMatrix } from './embeddings-matrix.mjs';
import { runRoutingMatrix } from './routing-matrix.mjs';
import { runNonStreamingToolMatrix } from './nonstreaming-tool-matrix.mjs';
import { runHTTPBoundaryMatrix } from './http-boundary-matrix.mjs';
import { runCancellationMatrix } from './cancellation-matrix.mjs';
import { runMediaMatrix } from './media-matrix.mjs';
import { runRealtimeMatrix } from './realtime-matrix.mjs';
import { runIAMMatrix } from './iam-matrix.mjs';
import { runExtensionMatrix } from './extension-matrix.mjs';
import { runOperationalMatrix } from './operational-matrix.mjs';
import { runAdvisoryMatrix } from './advisory-matrix.mjs';
import { runAlertsMatrix } from './alerts-matrix.mjs';
import { runCallerRateMatrix } from './caller-rate-matrix.mjs';
import { runDiscoveryMatrix } from './discovery-matrix.mjs';
import { runTransparentMatrix } from './transparent-matrix.mjs';
import { runPhaseMatrix } from './phase-matrix.mjs';
import { runMultimodalMatrix } from './multimodal-matrix.mjs';
import { runCompatibleMatrix } from './compatible-matrix.mjs';
import { runAzureMatrix } from './azure-matrix.mjs';
import { runOllamaMatrix } from './ollama-matrix.mjs';
import { runGoogleBoundaryMatrix } from './google-boundary-matrix.mjs';
import { runAudioNativeMatrix } from './audio-native-matrix.mjs';
import { runRefreshBindingMatrix } from './refresh-binding-matrix.mjs';
import { runRealWireMatrix } from './real-wire-matrix.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const option = name => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
const fixture = JSON.parse(readFileSync(join(directory, 'fixtures/recorded-groq-chat.json'), 'utf8'));
const frames = text => text.trim().split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => {
  const value = line.slice(5).trim(); return value === '[DONE]' ? value : JSON.parse(value);
})).flat();

async function client() {
  const origin = process.env.REPLAY_ORIGIN;
  const adminKey = process.env.REPLAY_ADMIN_KEY;
  const secrets = new Set();
  const registerSecret = secret => {
    if (typeof secret !== 'string' || !secret) return;
    for (let depth = 0; depth < 3; depth++) { secrets.add(secret); secret = JSON.stringify(secret).slice(1, -1); }
  };
  registerSecret(adminKey); registerSecret(process.env.REPLAY_SSO_SECRET);
  const redact = value => [...secrets].reduce((text, secret) => text.replaceAll(secret, '[temporary-key]'), String(value));
  const selected = new Set((process.env.REPLAY_CASES ?? '').split(',').filter(Boolean));
  const declared = new Set();
  assert.ok(origin && adminKey, 'isolated runner environment required');
  const results = { boundary: 'Real running Gateway public HTTP; recorded local provider stub', cases: [], selection: [...selected], liveProviderCalls: 0 };
  const save = (name, value) => writeFileSync(join('/artifacts', name), redact(JSON.stringify(value, null, 2)) + '\n');
  const metrics = async () => (await fetch('http://127.0.0.1:18889/metrics')).json();
  async function request(path, body, token = adminKey, compatibility = 'deny', requestId) {
    const startedAt = Date.now();
    const multipart = body instanceof FormData;
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestId ? { 'X-Request-ID': requestId } : {}), ...(!multipart ? { 'Content-Type': 'application/json' } : {}), ...(compatibility ? { 'X-LLMGW-Compatibility': compatibility } : {}) },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    const contentType = response.headers.get('content-type');
    const binary = !path.startsWith('/admin/') && !path.startsWith('/user/') && /^(?:audio|image|video)\/|^application\/octet-stream/.test(contentType ?? '');
    return { status: response.status, contentType, requestId: response.headers.get('x-request-id'), startedAt, elapsedMs: Date.now() - startedAt, text, ...(binary ? { bodyBase64: bytes.toString('base64') } : {}), headers: Object.fromEntries(response.headers) };
  }
  async function admin(path, body) {
    const response = await request('/admin/api/' + path, body);
    assert.ok(response.status >= 200 && response.status < 300, `${path}: ${response.status} ${response.text}`);
    const value = JSON.parse(response.text); registerSecret(value.token); return value;
  }
  async function test(name, run) {
    assert.ok(!declared.has(name), `duplicate HTTP case: ${name}`);
    declared.add(name);
    if (selected.size && !selected.has(name)) return;
    try { await run(); results.cases.push({ name, pass: true }); }
    catch (error) { results.cases.push({ name, pass: false, error: redact(error.message) }); }
    save('http-results.json', results);
  }
  const publicCall = async (name, path, body, token, compatibility) => {
    const requestId = 'fixture-http-' + name;
    const response = await request(path, body, token, compatibility, requestId);
    assert.equal(response.requestId, requestId, 'public request ID must survive the real HTTP boundary');
    const submitted = body instanceof FormData ? Object.fromEntries([...body.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : { name: value.name, type: value.type, bytes: value.size }])) : body;
    save(name + '.json', { path, request: submitted, compatibility: compatibility ?? 'deny', ...response }); return response;
  };
  try {
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(1000) })).ok) { healthy = true; break; } } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(healthy, 'isolated Gateway did not become healthy');
    for (const [id, wire, scenario] of [
      ['fixture-provider', 'chat', 'direct'], ['route-provider', 'chat', 'route'],
      ['usage-provider', 'chat', 'translated-usage'],
      ['reasoning-provider', 'chat', 'translated-reasoning'],
      ['partial-provider', 'chat', 'partial'], ['fallback-provider', 'chat', 'fallback'],
      ['responses-provider', 'responses', 'native'], ['broken-responses', 'responses', 'missing-terminal'],
    ]) {
      await admin('providers', { id, registry_id: wire === 'chat' ? 'groq' : 'openai', base_url: `http://upstream:18889/recorded/${wire}/${scenario}/v1`, api_key: 'fixture-provider-token' });
      await admin(`providers/${id}/refresh`, {});
    }
    await admin('endpoints', { name: 'recorded-route', ingress: ['/v1/chat/completions'], failover: [{ provider: 'route-provider', model: 'recorded-groq-model' }] });
    await admin('endpoints', { name: 'partial-route', ingress: ['/v1/chat/completions'], failover: [{ provider: 'partial-provider', model: 'recorded-groq-model' }, { provider: 'fallback-provider', model: 'recorded-groq-model' }] });
    const first = structuredClone(fixture.gateway_requests[0]);
    await test('public-catalog', async () => {
      const response = await request('/v1/models'); assert.equal(response.status, 200);
      assert.ok(JSON.parse(response.text).data.some(row => row.id === first.model));
    });
    await test('bare-alias-two-turn-recording', async () => {
      await admin('providers', { id: 'alias-provider', registry_id: 'groq', base_url: 'http://upstream:18889/recorded/chat/bare-alias/v1', api_key: 'fixture-provider-token' });
      await admin('providers/alias-provider/refresh', {});
      const human = await admin('principals', { kind: 'human', external_subject: 'fixture-alias-human', display_name: 'Bare alias caller' });
      const project = await admin('projects', { slug: 'recorded-bare-alias', name: 'Recorded bare alias' });
      await admin('memberships', { project_id: project.id, principal_id: human.id, role: 'owner' });
      await admin(`principals/${human.id}/connections`, { provider_id: 'alias-provider', connection_name: 'recorded-alias', credential_kind: 'api_key', secret: 'fixture-provider-token', make_default: true });
      await admin(`providers/alias-provider/refresh?principal_id=${human.id}`, {});
      const caller = await admin('keys', { project_id: project.id, principal_id: human.id, name: 'Bare alias caller', allowed_providers: ['alias-provider'] });
      const alias = 'recorded-groq-model';
      const catalog = await request('/v1/models', undefined, caller.token);
      assert.equal(catalog.status, 200);
      const catalogRows = JSON.parse(catalog.text).data;
      save('bare-alias-catalog.json', catalogRows);
      assert.ok(catalogRows.some(row => row.id === 'alias-provider/' + alias), 'the eligible native model must be discoverable; got ' + JSON.stringify(catalogRows.map(row => row.id)));
      const before = (await metrics()).recorded.accepted;
      let assistant;
      for (let turn = 0; turn < 2; turn++) {
        const input = structuredClone(fixture.gateway_requests[turn]); input.model = alias;
        if (turn === 1) { input.messages[1] = assistant; input.messages[2].tool_call_id = assistant.tool_calls[0].id; }
        const response = await publicCall('bare-alias-turn-' + turn, '/v1/chat/completions', input, caller.token);
        assert.equal(response.status, 200, response.text);
        const body = JSON.parse(response.text);
        assert.deepEqual(body, fixture.responses[turn]); assistant = body.choices[0].message;
      }
      const after = (await metrics()).recorded.accepted;
      assert.equal(after['chat/bare-alias'], 2, 'the eligible provider must receive both linked turns');
      for (const [name, count] of Object.entries(before)) if (name !== 'chat/bare-alias') assert.equal(after[name], count, 'an ineligible alias candidate must not be dispatched');
    });
    await test('legacy-completions-boundary-http', async () => {
      await admin('providers', { id: 'legacy-boundary-provider', registry_id: 'groq', base_url: 'http://upstream:18889/recorded/chat/legacy-boundary/v1', api_key: 'fixture-provider-token' });
      await admin('providers/legacy-boundary-provider/refresh', {});
      const model = 'legacy-boundary-provider/recorded-groq-model';
      const before = (await metrics()).inference;
      const unsupported = await request('/v1/completions', { model, prompt: 'Hello.', max_tokens: 32 });
      save('legacy-completions-absent.json', { path: '/v1/completions', ...unsupported });
      assert.equal(unsupported.status, 404, 'the declared data plane has no legacy completion engine');
      assert.equal((await metrics()).inference, before, 'an absent route must not dispatch upstream');
      const aliased = await publicCall('bare-completions-chat-alias', '/completions', { ...first, model });
      assert.equal(aliased.status, 200, aliased.text);
      assert.deepEqual(JSON.parse(aliased.text), fixture.responses[0], 'the bare path must retain the Chat wire and tool-call response');
      assert.equal((await metrics()).recorded.accepted['chat/legacy-boundary'], 1);
    });
    for (const [name, token] of [['missing-auth', ''], ['invalid-auth', 'fixture-invalid-token']]) await test(name, async () => {
      const before = (await metrics()).inference;
      assert.equal((await publicCall(name, '/v1/chat/completions', first, token)).status, 401);
      assert.equal((await metrics()).inference, before);
    });
    const restricted = await admin('keys', { project: 'recorded-http', name: 'Restricted fixture caller', allowed_models: ['fixture-provider/not-permitted'], allowed_providers: ['fixture-provider'] });
    await test('scoped-model-refusal', async () => {
      const before = (await metrics()).inference;
      assert.equal((await publicCall('scoped-model-refusal', '/v1/chat/completions', first, restricted.token)).status, 403);
      assert.equal((await metrics()).inference, before);
    });
    await test('native-only-refuses-conversion', async () => {
      const before = (await metrics()).inference;
      const response = await publicCall('native-only-refuses-conversion', '/v1/messages', { model: first.model, max_tokens: 32, messages: [{ role: 'user', content: 'Hello.' }] });
      assert.equal(response.status, 400); assert.match(response.text, /adaptation_required/);
      assert.equal((await metrics()).inference, before);
    });
    let actualAssistant;
    await test('recorded-tool-native-http', async () => {
      const response = await publicCall('recorded-tool-native-http', '/v1/chat/completions', first);
      assert.equal(response.status, 200); const body = JSON.parse(response.text);
      assert.deepEqual(body, fixture.responses[0]); actualAssistant = body.choices[0].message;
    });
    await test('wrong-tool-result-does-not-consume-record', async () => {
      const wrong = structuredClone(fixture.gateway_requests[1]); wrong.messages.at(-1).tool_call_id = 'fixture-wrong-association';
      const before = (await metrics()).recorded.accepted['chat/direct'];
      const response = await publicCall('wrong-tool-result-does-not-consume-record', '/v1/chat/completions', wrong);
      assert.ok([400, 422].includes(response.status), `status ${response.status}: ${response.text}`);
      assert.equal((await metrics()).recorded.accepted['chat/direct'], before);
    });
    await test('actual-http-tool-continuation', async () => {
      assert.ok(actualAssistant, 'first HTTP tool response required');
      const next = structuredClone(fixture.gateway_requests[1]); next.messages[1] = actualAssistant;
      next.messages[2].tool_call_id = actualAssistant.tool_calls[0].id;
      const response = await publicCall('actual-http-tool-continuation', '/v1/chat/completions', next);
      assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.text), fixture.responses[1]);
      assert.equal((await metrics()).recorded.accepted['chat/direct'], 2);
    });
    await test('recorded-chat-native-sse-http', async () => {
      const response = await publicCall('recorded-chat-native-sse-http', '/v1/chat/completions', fixture.gateway_requests[2]);
      assert.equal(response.status, 200); assert.match(response.contentType, /text\/event-stream/);
      assert.deepEqual(frames(response.text), frames(readFileSync(join(directory, 'fixtures/recorded-groq-chat.sse'), 'utf8')));
    });
    await test('translated-messages-stream-usage-http', async () => {
      const recorded = fixture.gateway_requests[2];
      const response = await publicCall('translated-messages-stream-usage-http', '/v1/messages', {
        model: 'usage-provider/recorded-groq-model', messages: recorded.messages,
        max_tokens: recorded.max_tokens, stream: true,
      }, undefined, 'allow');
      assert.equal(response.status, 200, response.text); assert.match(response.contentType, /text\/event-stream/);
      const usage = frames(readFileSync(join(directory, 'fixtures/synthetic-chat-usage.sse'), 'utf8')).findLast(frame => frame.usage)?.usage;
      assert.ok(usage?.prompt_tokens > 0, 'synthetic terminal input usage must be nonzero');
      const events = frames(response.text);
      assert.equal(events.find(frame => frame.type === 'error'), undefined, response.text);
      assert.equal(events.filter(frame => frame.type === 'message_stop').length, 1, 'translated stream must complete exactly once');
      const terminal = events.findLast(frame => frame.type === 'message_delta');
      assert.equal(terminal?.usage?.input_tokens, usage.prompt_tokens, 'prepared conversion must retain terminal input usage');
      assert.equal(terminal?.usage?.output_tokens, usage.completion_tokens, 'prepared conversion must retain terminal output usage');
      assert.equal((await metrics()).recorded.accepted['chat/translated-usage'], 1);
    });
    await test('translated-messages-reasoning-refusal-http', async () => {
      const recorded = fixture.gateway_requests[2];
      const response = await publicCall('translated-messages-reasoning-refusal-http', '/v1/messages', {
        model: 'reasoning-provider/recorded-groq-model', messages: recorded.messages,
        max_tokens: recorded.max_tokens, stream: true,
      }, undefined, 'allow');
      assert.equal(response.status, 200, response.text);
      assert.match(response.contentType, /text\/event-stream/);
      const events = frames(response.text);
      const errors = events.filter(frame => frame.type === 'error');
      assert.equal(errors.length, 1, 'unassessed vendor reasoning must produce exactly one error');
      assert.equal(errors[0].error.type, 'api_error');
      assert.equal(events.filter(frame => frame.type === 'message_stop').length, 0, 'a refused stream must not claim success');
      assert.equal(events.filter(frame => frame.type === 'message_delta').length, 0, 'usage not reached upstream must not be fabricated');
      assert.equal((await metrics()).recorded.accepted['chat/translated-reasoning'], 1, 'a refused open stream must not retry');
    });
    await test('named-route-two-turn-recording', async () => {
      let assistant;
      for (let turn = 0; turn < 2; turn++) {
        const body = structuredClone(fixture.gateway_requests[turn]); body.model = 'recorded-route';
        if (turn === 1) { assert.ok(assistant); body.messages[1] = assistant; body.messages[2].tool_call_id = assistant.tool_calls[0].id; }
        const response = await publicCall('named-route-turn-' + turn, '/v1/chat/completions', body);
        assert.equal(response.status, 200); const output = JSON.parse(response.text);
        assert.deepEqual(output, fixture.responses[turn]); assistant = output.choices[0].message;
      }
      assert.equal((await metrics()).recorded.accepted['chat/route'], 2);
    });
    await test('partial-recording-never-splices-fallback', async () => {
      const response = await publicCall('partial-recording-never-splices-fallback', '/v1/chat/completions', { ...fixture.gateway_requests[2], model: 'partial-route' });
      assert.equal(response.status, 200); assert.match(response.text, /fixture-id-6/); assert.doesNotMatch(response.text, /\[DONE\]/);
      const counts = (await metrics()).recorded.accepted;
      assert.equal(counts['chat/partial'], 1); assert.equal(counts['chat/fallback'] ?? 0, 0);
    });
    const responsesRequest = { model: 'responses-provider/fixture-codex-model', instructions: 'Reply with exactly OK.', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly OK.' }] }], stream: true, store: false };
    await test('recorded-responses-native-sse-http', async () => {
      const response = await publicCall('recorded-responses-native-sse-http', '/v1/responses', responsesRequest);
      assert.equal(response.status, 200); assert.match(response.contentType, /text\/event-stream/);
      assert.deepEqual(frames(response.text), frames(readFileSync(join(directory, 'fixtures/recorded-codex-responses.sse'), 'utf8')));
    });
    await test('missing-responses-terminal-is-not-success', async () => {
      const response = await publicCall('missing-responses-terminal-is-not-success', '/v1/responses', { ...responsesRequest, model: 'broken-responses/fixture-codex-model' });
      assert.doesNotMatch(response.text, /"type":"response.completed"/);
      assert.ok(response.status >= 400 || /response.failed|event: error|"error"/.test(response.text), 'missing-terminal EOF must be observable as failure');
    });
    await test('gateway-request-telemetry', async () => {
      // A separate recorded cursor makes this case independently selectable.
      await admin('providers', { id: 'telemetry-provider', registry_id: 'groq', base_url: 'http://upstream:18889/recorded/chat/telemetry/v1', api_key: 'fixture-provider-token' });
      await admin('providers/telemetry-provider/refresh', {});
      const caller = await admin('keys', { project: 'recorded-telemetry', name: 'Recorded telemetry caller' });
      const expected = [];
      async function observe(name, path, body, want, identity = caller) {
        const response = await publicCall(name, path, body, identity.token);
        expected.push({ name, path, body, response, identity: identity.key, ...want });
        return response;
      }
      const input = structuredClone(fixture.gateway_requests[0]); input.model = 'telemetry-provider/recorded-groq-model';
      const firstResponse = await observe('telemetry-tool', '/v1/chat/completions', input, { provider: 'telemetry-provider', usage: fixture.responses[0].usage });
      assert.equal(firstResponse.status, 200);
      const assistant = JSON.parse(firstResponse.text).choices[0].message;
      const next = structuredClone(fixture.gateway_requests[1]); next.model = input.model; next.messages[1] = assistant; next.messages[2].tool_call_id = assistant.tool_calls[0].id;
      const secondResponse = await observe('telemetry-continuation', '/v1/chat/completions', next, { provider: 'telemetry-provider', usage: fixture.responses[1].usage });
      assert.equal(secondResponse.status, 200);
      assert.deepEqual(JSON.parse(secondResponse.text), fixture.responses[1]);
      const streamBody = { ...fixture.gateway_requests[2], model: input.model };
      const stream = await observe('telemetry-stream', '/v1/chat/completions', streamBody, { provider: 'telemetry-provider', usage: frames(readFileSync(join(directory, 'fixtures/recorded-groq-chat.sse'), 'utf8')).findLast(frame => frame.usage)?.usage });
      assert.equal(stream.status, 200); assert.match(stream.text, /data: \[DONE\]/);
      const beforeFaults = (await metrics()).recorded.accepted;
      await observe('telemetry-partial', '/v1/chat/completions', { ...streamBody, model: 'partial-route' }, { provider: 'partial-provider', failure: true });
      await observe('telemetry-missing-terminal', '/v1/responses', { ...responsesRequest, model: 'broken-responses/fixture-codex-model' }, { provider: 'broken-responses', failure: true });
      const beforeRefusal = (await metrics()).inference;
      const refusal = await observe('telemetry-policy-refusal', '/v1/chat/completions', input, { refusal: true }, restricted);
      assert.equal(refusal.status, 403); assert.equal((await metrics()).inference, beforeRefusal);
      assert.equal((await metrics()).recorded.accepted['chat/fallback'] ?? 0, beforeFaults['chat/fallback'] ?? 0);

      let logs, rows;
      for (let i = 0; i < 20; i++) {
        logs = await admin('requests?limit=100'); rows = Array.isArray(logs) ? logs : (logs.requests ?? logs.rows ?? []);
        if (expected.every(item => rows.some(row => row.request_id === item.response.requestId))) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      save('gateway-request-telemetry.json', logs);
      for (const item of expected) {
        const matched = rows.filter(row => row.request_id === item.response.requestId);
        assert.equal(matched.length, 1, item.name + ': exactly one correlated ledger row');
        const row = matched[0];
        assert.equal(row.endpoint, item.path.endsWith('responses') ? 'openai.responses' : 'openai.chat', item.name);
        assert.equal(row.requested_model, item.body.model, item.name);
        assert.equal(row.project_id, item.identity.project_id, item.name);
        assert.equal(row.principal_id, item.identity.principal_id, item.name);
        assert.equal(row.key_id, item.identity.id, item.name);
        assert.ok(Number.isInteger(row.latency_ms) && row.latency_ms >= 0 && row.latency_ms <= item.response.elapsedMs + 500, item.name + ': bounded measured duration');
        assert.ok(row.ts >= Math.floor(item.response.startedAt / 1000) - 1 && row.ts <= Math.ceil((item.response.startedAt + item.response.elapsedMs) / 1000) + 1, item.name + ': request timestamp');
        if (item.refusal) {
          assert.equal(row.status_code, 403); assert.equal(row.source_usage?.attempts?.length ?? 0, 0);
          continue;
        }
        assert.equal(row.provider, item.provider, item.name);
        assert.equal(row.routed_model, item.path.endsWith('responses') ? 'fixture-codex-model' : 'recorded-groq-model', item.name);
        const evidence = row.source_usage;
        assert.ok(evidence, item.name + ': source evidence required');
        assert.equal(evidence.attempts.length, 1, item.name + ': one actual stub attempt');
        assert.equal(evidence.selected_attempt, 0);
        const attempt = evidence.attempts[0];
        assert.equal(attempt.attempt, 1); assert.equal(attempt.provider, item.provider); assert.equal(attempt.model, row.routed_model);
        if (item.failure) {
          assert.equal(row.status_code, 502); assert.equal(row.error_code, 'upstream_stream');
          assert.ok(['failed', 'truncated'].includes(attempt.quality));
          assert.equal(evidence.input_basis, 'estimated'); assert.equal(evidence.output_basis, 'estimated');
          assert.equal(attempt.counts.input_tokens.presence, 'absent'); assert.equal(attempt.counts.output_tokens.presence, 'absent');
        } else {
          assert.equal(row.status_code, 200); assert.equal(attempt.quality, 'complete');
          assert.equal(evidence.input_basis, 'reported'); assert.equal(evidence.output_basis, 'reported');
          assert.equal(row.input_tokens, item.usage.prompt_tokens); assert.equal(row.output_tokens, item.usage.completion_tokens);
          for (const [count, value] of [['input_tokens', item.usage.prompt_tokens], ['output_tokens', item.usage.completion_tokens], ['total_tokens', item.usage.total_tokens]]) {
            assert.equal(attempt.counts[count].presence, 'present'); assert.equal(attempt.counts[count].value, value);
          }
          const reasoning = item.usage.completion_tokens_details?.reasoning_tokens;
          if (reasoning !== undefined) assert.equal(attempt.counts.reasoning_tokens.value, reasoning);
        }
      }
      results.telemetryEntries = rows.length;
      results.telemetryAssertions = expected.map(item => ({ name: item.name, requestId: item.response.requestId, boundary: 'Actual Gateway HTTP to durable request ledger', reportedUsage: item.usage ?? null, expectedFailure: item.failure === true || item.refusal === true }));
    });
    await test('streaming-tool-conversation-matrix', async () => {
      await runStreamingToolMatrix({ admin, publicCall, metrics, save });
    });
    await test('embeddings-policy-and-accounting-matrix', async () => {
      await runEmbeddingsMatrix({ admin, publicCall, metrics, save });
    });
    await test('routing-policy-and-failure-matrix', async () => {
      await runRoutingMatrix({ admin, publicCall, request, metrics, save });
    });
    await test('nonstreaming-tool-conversation-matrix', async () => {
      await runNonStreamingToolMatrix({ admin, publicCall, metrics, save });
    });
    await test('http-count-header-alias-and-body-boundary-matrix', async () => {
      await runHTTPBoundaryMatrix({ admin, request, publicCall, metrics, save });
    });
    await test('all-wire-cancellation-matrix', async () => {
      await runCancellationMatrix({ admin, request, metrics, save });
    });
    await test('google-media-and-binary-audio-matrix', async () => {
      await runMediaMatrix({ admin, request, publicCall, metrics, save });
    });
    await test('native-realtime-and-gemini-manual-profile-matrix', async () => {
      await runRealtimeMatrix({ admin, request, publicCall, metrics, save });
    });
    await test('owner-iam-and-credential-lifecycle-matrix', async () => {
      await runIAMMatrix({ admin, request, publicCall, metrics, save, registerSecret });
    });
    await test('extension-discovery-capability-and-owned-oauth-matrix', async () => {
      await runExtensionMatrix({ admin, request, publicCall, metrics, save, registerSecret });
    });
    await test('installed-operational-quota-policy-and-limit-matrix', async () => {
      await runOperationalMatrix({ admin, request, publicCall, metrics, save, registerSecret });
    });
    await test('owner-advisory-scope-freshness-and-non-admission-matrix', async () => {
      await runAdvisoryMatrix({ admin, publicCall, metrics, save, registerSecret });
    });
    await test('installed-alert-rules-outbox-and-delivery-matrix', async () => {
      await runAlertsMatrix({ admin, request, metrics, save, registerSecret });
    });
    await test('initial-alias-catalog-discovery-cancellation-matrix', async () => {
      await runDiscoveryMatrix({ admin, publicCall, metrics, save });
    });
    await test('installed-transparent-native-fidelity-and-refusal-matrix', async () => {
      await runTransparentMatrix({ admin, metrics, save });
    });
    await test('native-responses-phase-preservation-and-adaptation-refusal-matrix', async () => {
      await runPhaseMatrix({ admin, request, publicCall, metrics, save });
    });
    await test('installed-image-file-and-pdf-conversion-matrix', async () => {
      await runMultimodalMatrix({ admin, publicCall, metrics, save, registerSecret });
    });
    await test('curated-compatible-host-auth-and-native-chat-matrix', async () => {
      await runCompatibleMatrix({ admin, request, publicCall, metrics, save, registerSecret });
    });
    if (process.env.REPLAY_CAPTURED_WIRE_FILE && /^\/v1beta\/models\/[^/]+:generateContent$/.test(JSON.parse(readFileSync(process.env.REPLAY_CAPTURED_WIRE_FILE, 'utf8')).path)) await test('actual-captured-ai-studio-chat-exact-wire-http', async () => {
      const observed = JSON.parse(readFileSync(process.env.REPLAY_CAPTURED_WIRE_FILE, 'utf8'));
      assert.ok(observed.complete && observed.request_complete && !observed.request_truncated && !observed.response_truncated && observed.status === 200);
      assert.deepEqual(observed.auth_forms, ['x-goog-api-key']);
      const model = observed.path.match(/^\/v1beta\/models\/([^/]+):generateContent$/)[1];
      registerSecret('fixture-captured-google-key');
      await admin('providers', { id: 'captured-native-google', type: 'ai_studio', base_url: 'http://upstream:18889/v1beta', api_key: 'fixture-captured-google-key' });
      await admin('providers/captured-native-google/refresh', {});
      const before = (await metrics()).capturedWire;
      const input = { model: 'captured-native-google/' + model, messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }], max_tokens: 32 };
      const answer = await publicCall('captured-ai-studio-chat', '/v1/chat/completions', input, adminKey, 'allow');
      assert.equal(answer.status, 200, answer.text);
      const expected = JSON.parse(Buffer.from(observed.response_body_base64, 'base64').toString('utf8')).candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('');
      assert.ok(expected); assert.equal(JSON.parse(answer.text).choices?.[0]?.message?.content, expected);
      const served = (await metrics()).capturedWire;
      assert.equal(served.served.length, before.served.length + 1);
      const changed = await request('/v1/chat/completions', { ...input, max_tokens: 33 }, adminKey, 'allow');
      assert.notEqual(changed.status, 200, 'a modified Gateway request must not borrow the original provider response');
      const rejected = (await metrics()).capturedWire;
      assert.equal(rejected.rejected, before.rejected + 1, 'changed outbound request must be refused by exact source-wire matcher');
    });
    if (process.env.REPLAY_CAPTURED_WIRE_FILE && !/^\/v1beta\/models\/[^/]+:generateContent$/.test(JSON.parse(readFileSync(process.env.REPLAY_CAPTURED_WIRE_FILE, 'utf8')).path)) await test('actual-captured-openrouter-wire-replays-only-the-exact-gateway-request', async () => {
      registerSecret('fixture-captured-source-key');
      const observed = JSON.parse(readFileSync(process.env.REPLAY_CAPTURED_WIRE_FILE, 'utf8'));
      assert.ok(observed.complete && observed.request_complete && observed.status === 200);
      const source = JSON.parse(Buffer.from(observed.request_body_base64, 'base64').toString('utf8'));
      await admin('providers', { id: 'captured-openrouter', registry_id: 'openrouter', base_url: 'http://upstream:18889/api/v1', api_key: 'fixture-captured-source-key' });
      await admin('providers/captured-openrouter/refresh', {});
      const before = (await metrics()).capturedWire.served.length;
      const answer = await publicCall('captured-openrouter-native-json', '/v1/chat/completions', { ...source, model: 'captured-openrouter/' + source.model });
      assert.equal(answer.status, 200, answer.text);
      const original = JSON.parse(Buffer.from(observed.response_body_base64, 'base64').toString('utf8'));
      assert.equal(JSON.parse(answer.text).choices[0].message.content, original.choices[0].message.content);
      const served = (await metrics()).capturedWire;
      assert.equal(served.served.length, before + 1); assert.equal(served.rejected, 0);
    });
    await test('azure-resource-deployment-auth-and-native-chat-matrix', async () => {
      await runAzureMatrix({ admin, request, publicCall, metrics, save, registerSecret });
    });
    await test('ollama-native-catalog-chat-adaptation-and-usage-matrix', async () => {
      await runOllamaMatrix({ admin, request, publicCall, metrics, save });
    });
    await test('google-native-and-compatible-boundary-matrix', async () => {
      await runGoogleBoundaryMatrix({ admin, request, publicCall, metrics, save, registerSecret });
    });
    await test('native-and-compatible-vendor-audio-boundary-matrix', async () => {
      await runAudioNativeMatrix({ admin, publicCall, metrics, save, registerSecret });
    });
    await test('same-request-catalog-refresh-project-policy-fencing-matrix', async () => {
      await runRefreshBindingMatrix({ admin, request, metrics, save, registerSecret });
    });
    await test('real-captured-upstream-wire-superserver-matrix', async () => {
      await runRealWireMatrix({ admin, request, publicCall, metrics, save, registerSecret });
    });
    await test('installed-request-log-metadata-excludes-synthetic-request-and-response-bodies', async () => {
      registerSecret('synthetic-private-body-marker');
      const response = await publicCall('request-log-boundary', '/v1/chat/completions', { model: 'iam-chat/fixture', messages: [{ role: 'user', content: 'synthetic-private-body-marker' }] });
      assert.equal(response.status, 200, response.text); assert.equal(JSON.parse(response.text).choices[0].message.content, 'credential:system');
    });
    if (process.env.REPLAY_CALLER_RATE_LIMIT) await test('process-local-caller-ceiling-and-bounded-retry-after', async () => {
      await runCallerRateMatrix({ admin, request, publicCall, metrics, save });
    });
    await test('bedrock-bearer-compatible-public-boundary', async () => {
      registerSecret('fixture-bedrock-bearer');
      await admin('providers', { id: 'bedrock-compatible', type: 'bedrock', base_url: 'http://upstream:18889/bedrock/v1', api_key: 'fixture-bedrock-bearer' });
      await admin('providers/bedrock-compatible/refresh', {});
      const model = 'bedrock-compatible/fixture-bedrock';
      const listing = await request('/v1/models'); assert.equal(listing.status, 200, listing.text);
      const visible = JSON.parse(listing.text).data.find(item => item.id === model); assert.ok(visible, 'the configured compatible catalog must be listed');
      assert.ok(visible.native_surfaces?.includes('/v1/responses')); assert.ok(!JSON.stringify(visible).includes('converse'));
      const before = (await metrics()).bedrock?.invocations ?? 0;
      const invoked = await publicCall('bedrock-compatible-responses', '/v1/responses', { model, input: 'Use the configured bearer endpoint', stream: false });
      assert.equal(invoked.status, 200, invoked.text); const output = JSON.parse(invoked.text);
      assert.equal(output.output[0].content[0].text, 'bearer-compatible-fixture'); assert.equal(output.usage.total_tokens, 5);
      const after = (await metrics()).bedrock; assert.equal(after.invocations, before + 1);
      assert.deepEqual(after.requests.at(-1), { path: '/bedrock/v1/responses', method: 'POST', authScheme: 'Bearer', awsSigned: false, model: 'fixture-bedrock' });
      for (const path of ['/v1/converse', '/v1/invoke-model', '/v1/bidirectional-speech']) {
        const refused = await request(path, { model, input: 'must not dispatch' }); assert.equal(refused.status, 404, path + ': ' + refused.text);
      }
      const audio = await request('/v1/audio/speech', { model, input: 'must not dispatch', voice: 'fixture' });
      assert.ok([400, 404].includes(audio.status), audio.text);
      assert.equal((await metrics()).bedrock.invocations, after.invocations, 'no unsupported AWS operation may be claimed or dispatched');
    });
    await test('incomplete-editor-paths-have-working-api-and-explicit-adaptation-permission', async () => {
      registerSecret('fixture-routing-token');
      await admin('providers', { id: 'gap-configured', registry_id: 'openai', base_url: 'http://upstream:18889/routing/healthy/v1', api_key: 'fixture-routing-token', force_api_support: true });
      await admin('providers/gap-configured/refresh', {});
      const configured = (await admin('state')).providers.find(item => item.id === 'gap-configured');
      assert.equal(configured.force_api_support, true, 'supported admin API persists the option despite uneven editor coverage');
      const before = (await metrics()).inference;
      const body = { model: 'gap-configured/fixture', messages: [{ role: 'user', content: 'routing:success' }], max_tokens: 17, temperature: 0.125 };
      const denied = await publicCall('gap-force-does-not-grant-compatibility', '/v1/messages', body, undefined, 'deny');
      assert.equal(denied.status, 400, denied.text); assert.match(denied.text, /adaptation_required/);
      assert.equal((await metrics()).inference, before, 'a persisted force_api_support flag must not bypass explicit compatibility');
      const allowed = await publicCall('gap-explicit-compatibility-serves', '/v1/messages', body, undefined, 'allow');
      assert.equal(allowed.status, 200, allowed.text); assert.equal((await metrics()).inference, before + 1);
    });
    await test('recorded-transcription-multipart-http', async () => {
      const recording = JSON.parse(readFileSync(join(directory, 'fixtures/recorded-groq-transcription.json'), 'utf8'));
      await admin('providers', { id: 'transcription-provider', registry_id: 'groq', base_url: 'http://upstream:18889/recorded/transcription/native/v1', api_key: 'fixture-provider-token' });
      await admin('providers/transcription-provider/refresh', {});
      const form = new FormData();
      form.set('model', 'transcription-provider/' + recording.request.model);
      form.set('language', recording.request.language); form.set('response_format', recording.request.response_format);
      form.set('file', new Blob([readFileSync(join(directory, 'fixtures', recording.request.audio_file))], { type: recording.request.audio_type }), recording.request.audio_file);
      const response = await publicCall('recorded-transcription-multipart-http', '/v1/audio/transcriptions', form);
      assert.equal(response.status, 200, response.text); assert.match(response.contentType, /application\/json/);
      assert.deepEqual(JSON.parse(response.text), recording.response);
      assert.equal((await metrics()).recorded.accepted['transcription/native'], 1);
      // A constant response stub must not pass when the uploaded audio changes.
      const before = await metrics();
      form.set('file', new Blob([Buffer.from('not the recorded audio')], { type: recording.request.audio_type }), recording.request.audio_file);
      const rejected = await publicCall('recorded-transcription-mismatch-http', '/v1/audio/transcriptions', form);
      assert.ok(rejected.status >= 400, rejected.text);
      const after = await metrics();
      assert.equal(after.recorded.accepted['transcription/native'], 1);
      assert.equal(after.recorded.rejected, before.recorded.rejected + 1);
    });
    await test('recorded-native-responses-tool-conversation-http', async () => {
      const recording = JSON.parse(readFileSync(join(directory, 'fixtures/recorded-codex-tools.json'), 'utf8'));
      await admin('providers', { id: 'tool-responses-provider', registry_id: 'openai', base_url: 'http://upstream:18889/recorded/responses-tools/native/v1', api_key: 'fixture-provider-token' });
      await admin('providers/tool-responses-provider/refresh', {});
      const publicModel = 'tool-responses-provider/fixture-codex-model';
      const human = await admin('principals', { kind: 'human', external_subject: 'fixture-responses-human', display_name: 'Recorded Responses caller' });
      const project = await admin('projects', { slug: 'recorded-responses', name: 'Recorded Responses' });
      await admin('memberships', { project_id: project.id, principal_id: human.id, role: 'owner' });
      await admin(`principals/${human.id}/connections`, { provider_id: 'tool-responses-provider', connection_name: 'synthetic-replay', credential_kind: 'api_key', secret: 'fixture-private-token', make_default: true });
      await admin(`providers/tool-responses-provider/refresh?principal_id=${human.id}`, {});
      const caller = await admin('keys', { project_id: project.id, principal_id: human.id, name: 'Recorded private Responses caller', allowed_models: [publicModel], allowed_providers: ['tool-responses-provider'] });
      const first = await publicCall('recorded-native-responses-tool-http', '/v1/responses', { ...recording.turns[0].request, model: publicModel }, caller.token);
      assert.equal(first.status, 200, first.text);
      assert.deepEqual(frames(first.text), frames(recording.turns[0].sse));
      const completed = frames(first.text).filter(event => event.type === 'response.completed');
      assert.equal(completed.length, 1);
      const actualItems = completed[0].response.output;
      const calls = actualItems.filter(item => item.type === 'function_call');
      assert.equal(calls.length, 1); assert.equal(calls[0].name, 'qualification_sum');
      assert.deepEqual(JSON.parse(calls[0].arguments), { a: 2, b: 3 });
      const continuation = { ...recording.turns[1].request, model: publicModel, input: [...recording.turns[0].request.input, ...actualItems, { type: 'function_call_output', call_id: calls[0].call_id, output: '5' }] };
      const notPrivate = await publicCall('recorded-native-responses-private-connection-required', '/v1/responses', continuation);
      assert.equal(notPrivate.status, 403);
      assert.match(notPrivate.text, /private human provider connection/);
      assert.equal((await metrics()).recorded.accepted['responses-tools/native'], 1);
      const wrong = structuredClone(continuation); wrong.input.at(-1).call_id = 'fixture-unrelated-call';
      const rejected = await publicCall('recorded-native-responses-wrong-tool-http', '/v1/responses', wrong, caller.token);
      assert.ok(rejected.status >= 400, rejected.text);
      assert.equal((await metrics()).recorded.accepted['responses-tools/native'], 1);
      const next = await publicCall('recorded-native-responses-tool-result-http', '/v1/responses', continuation, caller.token);
      assert.equal(next.status, 200, next.text);
      assert.deepEqual(frames(next.text), frames(recording.turns[1].sse));
      const final = frames(next.text).filter(event => event.type === 'response.completed');
      assert.equal(final.length, 1);
      const answer = final[0].response.output.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('').trim();
      assert.equal(answer, '5');
      assert.equal((await metrics()).recorded.accepted['responses-tools/native'], 2);
    });
    await test('gateway-metrics-require-their-own-token-and-name-the-running-build', async () => {
      const before = (await metrics()).inference;
      assert.equal((await request('/metrics', undefined, '')).status, 401);
      assert.equal((await request('/metrics', undefined, adminKey)).status, 401);
      const response = await request('/metrics', undefined, 'fixture-metrics-token');
      assert.equal(response.status, 200, response.text); assert.match(response.contentType, /text\/plain/);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.ok(!response.text.includes(adminKey) && !response.text.includes('fixture-metrics-token'));
      const build = response.text.split(/\r?\n/).find(line => line.startsWith('llmgw_build_info{'));
      assert.ok(build); assert.match(build, /commit="unknown"/);
      const count = response.text.split(/\r?\n/).filter(line => line.startsWith('llmgw_http_requests_total{')).reduce((total, line) => total + Number(line.match(/ (\d+)$/)?.[1] ?? 0), 0);
      assert.ok(count > 20, 'the real process must have recorded installed HTTP activity');
      assert.equal((await metrics()).inference, before, 'scraping metrics cannot infer');
      writeFileSync('/artifacts/metrics-seed-private.json', JSON.stringify({ build, requests: count }) + '\n', { mode: 0o600 });
    });
    results.upstreamMetrics = await metrics();
  } catch (error) { results.setupError = redact(error.message); }
  results.pass = !results.setupError && results.cases.length === (selected.size || declared.size) && results.cases.every(row => row.pass);
  save('http-results.json', results);
  console.log(JSON.stringify({ pass: results.pass, cases: results.cases, setupError: results.setupError }));
  if (!results.pass) process.exitCode = 1;
}

async function orchestrate() {
  const image = option('image'); assert.ok(image, 'pass --image=<already-built Gateway image>');
  const profile = option('profile') ?? 'replay';
  assert.ok(['replay', 'fresh', 'upgrade'].includes(profile), 'profile must be replay, fresh or upgrade');
  const browserEnabled = process.argv.includes('--browser');
  const shutdownEnabled = process.argv.includes('--shutdown');
  const callerRateLimit = option('caller-rate-limit');
  const capturedWireFile = option('captured-wire-file') ? resolve(option('captured-wire-file')) : '';
  assert.ok(!capturedWireFile || existsSync(capturedWireFile), 'selected private captured-wire file must exist');
  const captureIDs = option('capture-ids')?.split(',').filter(Boolean) ?? [];
  assert.ok(captureIDs.length <= 10 && captureIDs.every(id => /^[A-Za-z0-9._:-]{1,128}$/.test(id)), 'selected capture IDs must be valid request IDs, at most ten');
  const externalKeysEnabled = process.argv.includes('--external-keys');
  const ownerBrowserEnabled = process.argv.includes('--owner-browser');
  const clientsEnabled = process.argv.includes('--clients');
  const browserRuntime = option('browser-runtime') ? resolve(option('browser-runtime')) : undefined;
  const clientRuntime = option('client-runtime') ? resolve(option('client-runtime')) : undefined;
  assert.ok(!browserEnabled || profile !== 'replay', '--browser requires a seeded fresh or upgrade profile');
  assert.ok(!shutdownEnabled || profile !== 'replay', '--shutdown requires a seeded fresh or upgrade profile');
  assert.ok(!callerRateLimit || (profile !== 'replay' && callerRateLimit === '2'), '--caller-rate-limit=2 requires a seeded profile');
  assert.ok(!externalKeysEnabled || profile !== 'replay', '--external-keys requires a disposable seeded profile');
  assert.ok(!ownerBrowserEnabled || (browserEnabled && browserRuntime), '--owner-browser requires --browser and --browser-runtime=<private pinned TLS/axe runtime>');
  assert.ok(!clientsEnabled || (profile !== 'replay' && browserEnabled && clientRuntime), '--clients requires a seeded profile, --browser and --client-runtime=<private pinned SDK/CLI runtime>');
  if (clientsEnabled) for (const file of ['node_modules/openai/package.json', 'node_modules/@anthropic-ai/sdk/package.json', 'node_modules/@github/copilot-win32-x64/copilot.exe']) assert.ok(existsSync(join(clientRuntime, file)), 'missing private client runtime file: ' + file);
  if (ownerBrowserEnabled) for (const file of ['owner-key.pem', 'owner-cert.pem', 'node_modules/axe-core/axe.min.js']) assert.ok(existsSync(join(browserRuntime, file)), 'missing private browser runtime file: ' + file);
  const docker = (args, timeout = 20000) => execFileSync('docker', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  const gatewayImage = JSON.parse(docker(['image', 'inspect', image]))[0];
  let baselineImage;
  if (profile === 'upgrade') {
    assert.ok(option('baseline-image'), 'upgrade requires --baseline-image=<installed Gateway image>');
    baselineImage = JSON.parse(docker(['image', 'inspect', option('baseline-image')]))[0];
    assert.notEqual(gatewayImage.Id, baselineImage.Id, 'upgrade requires distinct image identities; a restart is not an upgrade');
  }
  const artifacts = resolve(option('artifacts') ?? join(tmpdir(), 'llmgw-recorded-http-' + randomBytes(6).toString('hex')));
  assert.ok(existsSync(dirname(artifacts)), 'artifact parent directory must exist');
  assert.ok(!existsSync(artifacts), 'use a fresh artifact directory to retain prior failures'); mkdirSync(artifacts, { mode: 0o700 });
  const captureDir = captureIDs.length ? join(artifacts, 'wire-captures') : '';
  if (captureDir) mkdirSync(captureDir, { mode: 0o700 });
  const suffix = randomBytes(6).toString('hex'), network = 'llmgw-recorded-' + suffix;
  const gateway = network + '-gateway', upstream = network + '-upstream', maintenance = network + '-maintenance', rollbackGateway = network + '-rollback', archiveGateway = network + '-archive', rekeyGateway = network + '-rekey', wrongKeyGateway = network + '-wrong-key', externalGateway = network + '-external';
  const browserNetwork = network + '-browser', browserProxy = network + '-browser-proxy';
  const key = randomBytes(32).toString('hex'), encryptionKey = randomBytes(32).toString('base64'), ssoSecret = randomBytes(32).toString('hex');
  const volume = network + '-state';
  const baselineVolume = network + '-baseline-state';
  const rollbackVolume = network + '-rollback-state';
  const archiveVolume = network + '-archive-state', archiveRestoredVolume = network + '-archive-restored-state', rekeyVolume = network + '-rekey-state', externalVolume = network + '-external-state';
    const receipt = { image, profile, boundary: 'Actual Gateway process in Docker; all test requests over HTTP', artifacts, containers: [gateway, upstream, maintenance], volumes: [], sourceReview: 'Not performed by this runner; not release certification' };
  let rotatedEncryptionKey = '';
  const redact = value => {
    const text = String(value).replaceAll(key, '[temporary-key]').replaceAll(encryptionKey, '[temporary-encryption-key]').replaceAll(ssoSecret, '[temporary-sso-secret]').replaceAll('fixture-metrics-token', '[temporary-metrics-token]');
    return rotatedEncryptionKey ? text.replaceAll(rotatedEncryptionKey, '[rotated-temporary-encryption-key]') : text;
  };
  try {
    const nodeImage = JSON.parse(docker(['image', 'inspect', option('node-image') ?? 'node:22-alpine']))[0];
    receipt.imageId = gatewayImage.Id; receipt.nodeImageId = nodeImage.Id;
    const mounts = ['--mount', `type=bind,source=${dirname(directory)},target=/tests,readonly`, '--mount', `type=bind,source=${artifacts},target=/artifacts`];
    const stateClient = mode => {
      if (mode !== 'seed' && receipt.installed?.seed?.ownerSeeded) assert.ok(existsSync(join(artifacts, 'owner-seed-private.json')), 'the original owner fixture must remain available for state verification');
      try { docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + key, '-e', 'REPLAY_SSO_SECRET=' + ssoSecret, upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--state=' + mode], 90000); }
      catch (error) { if (!existsSync(join(artifacts, `state-${mode}-results.json`))) throw error; }
      const value = JSON.parse(readFileSync(join(artifacts, `state-${mode}-results.json`), 'utf8'));
      if (mode !== 'seed' && receipt.installed?.seed?.ownerSeeded) assert.equal(value.ownerRecovery?.pass, true, 'the original SSO identities, owner keys and credentials must survive ' + mode);
      return value;
    };
    const stateVolume = (operation, name, readonly = false) => JSON.parse(docker(['run', '--rm', '--pull=never', '--name', maintenance, '--network', 'none', ...mounts, '--mount', `type=volume,source=${name},target=/state${readonly ? ',readonly' : ''}`, ...(receipt.upgrade?.snapshot ? ['-e', 'SNAPSHOT_SHA256=' + receipt.upgrade.snapshot.manifestSha256] : []), nodeImage.Id, 'node', '/tests/qualification/state-volume.mjs', operation], 60000));
    if (profile !== 'replay') {
      const initialVolume = profile === 'upgrade' ? baselineVolume : volume;
      docker(['volume', 'create', initialVolume]); receipt.volumes.push(initialVolume);
      stateVolume('initialize', initialVolume);
    }
    docker(['network', 'create', '--internal', network]);
    receipt.internalNetwork = JSON.parse(docker(['network', 'inspect', network]))[0].Internal;
    assert.equal(receipt.internalNetwork, true);
    docker(['run', '-d', '--pull=never', '--name', upstream, '--network', network, '--network-alias', 'upstream', '--network-alias', 'untrusted', '--network-alias', 'azure-resource', '--network-alias', 'azure-redirect', '--network-alias', 'azure-untrusted', ...mounts, ...(capturedWireFile ? ['--mount', `type=bind,source=${dirname(capturedWireFile)},target=/recorded-capture,readonly`] : []), nodeImage.Id, 'node', '/tests/integration/fake-upstream.mjs', '--recorded', '--host=0.0.0.0', ...(capturedWireFile ? ['--captured-wire-file=/recorded-capture/' + basename(capturedWireFile)] : [])]);
    const startGateway = (selectedImage, selectedVolume, container = gateway, credentialKey = encryptionKey, extraEnv = []) => {
      const stateMount = profile === 'replay' ? ['--tmpfs', '/state:rw,noexec,nosuid,size=64m,uid=65532,gid=65532,mode=0700'] : ['--mount', `type=volume,source=${selectedVolume},target=/state`];
      docker(['run', '-d', '--pull=never', '--name', container, '--network', network, '--network-alias', 'gateway', ...stateMount, ...(captureDir ? ['--mount', `type=bind,source=${captureDir},target=/capture`, '-e', 'LLMGW_CAPTURE_DIR=/capture', '-e', 'LLMGW_CAPTURE_REQUEST_IDS=' + captureIDs.join(','), '-e', 'LLMGW_CAPTURE_MAX_ATTEMPTS=10'] : []), '-e', 'LLMGW_STATE_DIR=/state', '-e', 'LLMGW_CONFIG=/state/config.yaml', '-e', 'LLMGW_HOST=0.0.0.0', '-e', 'LLMGW_PORT=8787', '-e', 'LLMGW_AUTODISCOVER_LOCAL=0', '-e', 'LLMGW_LOG_REQUESTS=1', '-e', 'LLMGW_API_KEY=' + key, '-e', 'LLMGW_CREDENTIAL_ENCRYPTION_KEY=' + credentialKey, '-e', 'LLMGW_METRICS_TOKEN=fixture-metrics-token', ...(callerRateLimit ? ['-e', 'LLMGW_RATE_LIMIT_PER_MINUTE=' + callerRateLimit] : []), '-e', 'LLMGW_SSO_ENABLED=1', '-e', 'LLMGW_SSO_SHARED_SECRET=' + ssoSecret, '-e', 'LLMGW_SSO_ADMIN_GROUP=fixture-admin', '-e', 'LLMGW_SSO_AUTO_PROVISION=1', '-e', 'LLMGW_GITHUB_COPILOT_OAUTH_TOKEN=fixture-extension-shared-token', '-e', 'LLMGW_GITHUB_COPILOT_USE_GH_CLI=0', ...extraEnv, selectedImage, 'serve']);
    };
    const fixtureStreamCut = () => JSON.parse(docker(['exec', upstream, 'node', '-e', "fetch('http://127.0.0.1:18889/browser-gap/control/cut',{method:'POST'}).then(async response=>{if(!response.ok)process.exit(1);console.log(await response.text())})"], 10000)).cut;
    startGateway(baselineImage?.Id ?? gatewayImage.Id, profile === 'upgrade' ? baselineVolume : volume);
    if (profile !== 'replay') {
      receipt.installed = { seed: stateClient('seed') };
      assert.equal(receipt.installed.seed.pass, true, receipt.installed.seed.setupError ?? 'could not seed installed state');
      receipt.installed.seedCli = { version: docker(['exec', gateway, '/llmgw', 'version']).trim() };
      if (profile === 'upgrade') {
        receipt.upgrade = { baselineImageId: baselineImage.Id, baselineReference: option('baseline-image'), originalVolume: baselineVolume, candidateVolume: volume };
        docker(['stop', '--time', '20', gateway], 30000);
        receipt.upgrade.snapshot = stateVolume('snapshot', baselineVolume, true);
        const logs = spawnSync('docker', ['logs', gateway], { encoding: 'utf8', timeout: 10000 });
        writeFileSync(join(artifacts, 'baseline.log'), redact(logs.stdout + logs.stderr));
        docker(['rm', '-v', gateway]);
        docker(['volume', 'create', volume]); receipt.volumes.push(volume);
        receipt.upgrade.restored = stateVolume('restore', volume);
        startGateway(gatewayImage.Id, volume);
      }
      receipt.installed.firstStart = stateClient('first-start');
      receipt.installed.cli = { version: docker(['exec', gateway, '/llmgw', 'version']).trim(), health: docker(['exec', gateway, '/llmgw', 'health']).trim() };
      assert.match(receipt.installed.cli.version, /llm-gateway/);
      if (browserEnabled) {
        receipt.browser = {};
        docker(['network', 'create', browserNetwork]);
        receipt.browser.network = browserNetwork;
        const browserRuntimeMount = ownerBrowserEnabled ? ['--mount', `type=bind,source=${browserRuntime},target=/browser-runtime,readonly`, '-e', 'REPLAY_AXE_SCRIPT=/browser-runtime/node_modules/axe-core/axe.min.js'] : [];
        docker(['run', '-d', '--pull=never', '--name', browserProxy, '--network', network, '-p', '127.0.0.1::8787', ...mounts, ...browserRuntimeMount, nodeImage.Id, 'node', '/tests/qualification/browser-proxy.mjs']);
        receipt.containers.push(browserProxy);
        docker(['network', 'connect', browserNetwork, browserProxy]);
        const mapping = JSON.parse(docker(['inspect', browserProxy]))[0].NetworkSettings.Ports['8787/tcp'];
        assert.equal(mapping.length, 1);
        assert.equal(mapping[0].HostIp, '127.0.0.1');
        receipt.browser.origin = 'http://127.0.0.1:' + mapping[0].HostPort;
        receipt.browser.firstStart = await runInstalledBrowser({ origin: receipt.browser.origin, adminKey: key, artifacts, phase: 'first-start' });
        if (ownerBrowserEnabled) {
          receipt.ownerBrowser = { origins: {} };
          const identities = { ...ownerActors, empty: { subject: 'qualification-empty', name: 'Qualification no-project owner', email: 'empty@example.test' } };
          for (const [actor, identity] of Object.entries(identities)) {
            const name = network + '-owner-' + actor;
            docker(['run', '-d', '--pull=never', '--name', name, '--network', network, '-p', '127.0.0.1::8787', ...mounts, ...browserRuntimeMount,
              '-e', 'REPLAY_TLS_KEY=/browser-runtime/owner-key.pem', '-e', 'REPLAY_TLS_CERT=/browser-runtime/owner-cert.pem', '-e', 'REPLAY_SSO_SECRET=' + ssoSecret,
              '-e', 'REPLAY_SSO_SUBJECT=' + identity.subject, '-e', 'REPLAY_SSO_NAME=' + identity.name, '-e', 'REPLAY_SSO_EMAIL=' + identity.email, '-e', 'REPLAY_SSO_GROUPS=' + (identity.groups ?? ''), nodeImage.Id, 'node', '/tests/qualification/browser-proxy.mjs']);
            receipt.containers.push(name); docker(['network', 'connect', browserNetwork, name]);
            const ports = JSON.parse(docker(['inspect', name]))[0].NetworkSettings.Ports['8787/tcp']; assert.equal(ports[0].HostIp, '127.0.0.1');
            receipt.ownerBrowser.origins[actor] = 'https://127.0.0.1:' + ports[0].HostPort;
          }
          const fixtureMode = value => { assert.ok(['expired', 'absent'].includes(value)); docker(['exec', upstream, 'node', '-e', `fetch('http://127.0.0.1:18889/daemon/control/expiry', {method:'POST', body:JSON.stringify({mode:'${value}'})}).then(response => {if (!response.ok) process.exit(1)})`]); };
          receipt.ownerBrowser.firstStart = await runOwnerBrowser({ origins: receipt.ownerBrowser.origins, artifacts, runtime: browserRuntime, phase: 'first-start', knownSecrets: [key, ssoSecret], fixtureMode, fixtureStreamCut });
        }
      }
    }
    if (clientsEnabled) receipt.installedClients = await runInstalledClients({ origin: receipt.browser.origin, adminKey: key, artifacts, runtime: clientRuntime });
    try { receipt.clientOutput = docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + key, '-e', 'REPLAY_SSO_SECRET=' + ssoSecret, '-e', 'REPLAY_CASES=' + (option('cases') ?? ''), ...(capturedWireFile ? ['-e', 'REPLAY_CAPTURED_WIRE_FILE=/recorded-capture/' + basename(capturedWireFile)] : []), ...(callerRateLimit ? ['-e', 'REPLAY_CALLER_RATE_LIMIT=' + callerRateLimit] : []), upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--client'], 180000); }
    catch (error) { receipt.clientExit = error.status; receipt.clientOutput = error.stdout?.toString(); }
    receipt.results = JSON.parse(readFileSync(join(artifacts, 'http-results.json'), 'utf8'));
    if (shutdownEnabled && receipt.results.pass) receipt.shutdown = await runInstalledShutdown({ docker, gateway, upstream, adminKey: key, artifacts });
    receipt.mediaRestartRequired = profile !== 'replay' && receipt.results.cases.some(row => row.name === 'google-media-and-binary-audio-matrix');
    receipt.extensionRestartRequired = profile !== 'replay' && receipt.results.cases.some(row => row.name === 'extension-discovery-capability-and-owned-oauth-matrix');
    receipt.operationalRestartRequired = profile !== 'replay' && receipt.results.cases.some(row => row.name === 'installed-operational-quota-policy-and-limit-matrix');
    receipt.metricsRestartRequired = profile !== 'replay' && receipt.results.cases.some(row => row.name === 'gateway-metrics-require-their-own-token-and-name-the-running-build');
    receipt.callerRateRestartRequired = Boolean(callerRateLimit && receipt.results.cases.some(row => row.name === 'process-local-caller-ceiling-and-bounded-retry-after'));
    receipt.discoveryRestartRequired = profile !== 'replay' && receipt.results.cases.some(row => row.name === 'initial-alias-catalog-discovery-cancellation-matrix');
    receipt.transparentRestartRequired = profile !== 'replay' && receipt.results.cases.some(row => row.name === 'installed-transparent-native-fidelity-and-refusal-matrix');
    receipt.logInspectionRequired = profile !== 'replay' && receipt.results.cases.some(row => row.name === 'installed-request-log-metadata-excludes-synthetic-request-and-response-bodies');
    if (receipt.mediaRestartRequired && receipt.results.pass) assert.ok(existsSync(join(artifacts, 'media-seed-private.json')), 'successful media qualification must retain its restart handles');
    if (receipt.extensionRestartRequired && receipt.results.pass) assert.ok(existsSync(join(artifacts, 'extension-seed-private.json')), 'successful extension qualification must retain its private restart fixture');
    if (receipt.operationalRestartRequired && receipt.results.pass) assert.ok(existsSync(join(artifacts, 'operational-seed-private.json')), 'successful operational qualification must retain its private restart fixture');
    if (receipt.metricsRestartRequired && receipt.results.pass) assert.ok(existsSync(join(artifacts, 'metrics-seed-private.json')), 'successful metrics qualification must retain its process baseline');
    if (receipt.callerRateRestartRequired && receipt.results.pass) assert.ok(existsSync(join(artifacts, 'caller-rate-seed-private.json')), 'successful caller-rate qualification must retain its project key and UTC minute');
    if (receipt.discoveryRestartRequired && receipt.results.pass) assert.ok(existsSync(join(artifacts, 'discovery-seed-private.json')), 'successful catalog cancellation must retain its scoped caller for a stale-catalog restart');
    if (receipt.discoveryRestartRequired && receipt.results.pass) writeFileSync(join(artifacts, 'discovery-current-private.json'), JSON.stringify(receipt.results.upstreamMetrics.discovery) + '\n', { mode: 0o600 });
    if (receipt.transparentRestartRequired && receipt.results.pass) assert.ok(existsSync(join(artifacts, 'transparent-seed-private.json')), 'transparent negatives must retain their own stopped-copy positive fixture');
    if (profile !== 'replay') {
      if (receipt.results.pass && (receipt.discoveryRestartRequired || receipt.transparentRestartRequired || receipt.logInspectionRequired)) {
        if (JSON.parse(docker(['inspect', gateway]))[0].State.Running) docker(['stop', '--time', '20', gateway], 30000);
      }
      if (receipt.logInspectionRequired && receipt.results.pass) {
        receipt.logInspection = stateVolume('inspect-request-log', volume, true);
        assert.equal(receipt.logInspection.inspected, true);
      }
      if (receipt.discoveryRestartRequired && receipt.results.pass) {
        receipt.discoveryAged = stateVolume('age-discovery-catalog', volume);
        assert.equal(receipt.discoveryAged.aged, true);
        docker(['exec', upstream, 'node', '-e', "fetch('http://127.0.0.1:18889/discovery/control/hold',{method:'POST'}).then(response=>{if(!response.ok)process.exit(1)})"], 10000);
      }
      if (receipt.transparentRestartRequired && receipt.results.pass) {
        receipt.transparentTrusted = stateVolume('trust-transparent-catalog', volume);
        assert.equal(receipt.transparentTrusted.trustedCatalogInjected, true);
      }
      docker(['restart', gateway], 30000);
      if (receipt.discoveryRestartRequired && receipt.results.pass) {
        try { docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--discovery-recovery=restart'], 60000); }
        catch (error) { if (!existsSync(join(artifacts, 'discovery-restart-results.json'))) throw error; }
        receipt.discoveryRestart = JSON.parse(readFileSync(join(artifacts, 'discovery-restart-results.json'), 'utf8'));
      }
      if (receipt.transparentRestartRequired && receipt.results.pass) {
        try { docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + key, upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--transparent-recovery=restart'], 60000); }
        catch (error) { if (!existsSync(join(artifacts, 'transparent-restart-results.json'))) throw error; }
        receipt.transparentRestart = JSON.parse(readFileSync(join(artifacts, 'transparent-restart-results.json'), 'utf8'));
      }
      if (receipt.metricsRestartRequired) {
        try { docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--metrics-recovery=restart'], 60000); }
        catch (error) { if (!existsSync(join(artifacts, 'metrics-restart-results.json'))) throw error; }
        receipt.metricsRestart = JSON.parse(readFileSync(join(artifacts, 'metrics-restart-results.json'), 'utf8'));
      }
      if (receipt.callerRateRestartRequired) {
        try { docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + key, upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--rate-recovery=restart'], 60000); }
        catch (error) { if (!existsSync(join(artifacts, 'caller-rate-restart-results.json'))) throw error; }
        receipt.callerRateRestart = JSON.parse(readFileSync(join(artifacts, 'caller-rate-restart-results.json'), 'utf8'));
      }
      receipt.installed.restart = stateClient('restart');
      if (existsSync(join(artifacts, 'media-seed-private.json'))) {
        try { docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + key, upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--media-recovery=restart'], 60000); }
        catch (error) { if (!existsSync(join(artifacts, 'media-restart-results.json'))) throw error; }
        receipt.mediaRestart = JSON.parse(readFileSync(join(artifacts, 'media-restart-results.json'), 'utf8'));
      }
      if (existsSync(join(artifacts, 'extension-seed-private.json'))) {
        try { docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + key, upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--extension-recovery=restart'], 60000); }
        catch (error) { if (!existsSync(join(artifacts, 'extension-restart-results.json'))) throw error; }
        receipt.extensionRestart = JSON.parse(readFileSync(join(artifacts, 'extension-restart-results.json'), 'utf8'));
      }
      if (existsSync(join(artifacts, 'operational-seed-private.json'))) {
        try { docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + key, upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--operational-recovery=restart'], 60000); }
        catch (error) { if (!existsSync(join(artifacts, 'operational-restart-results.json'))) throw error; }
        receipt.operationalRestart = JSON.parse(readFileSync(join(artifacts, 'operational-restart-results.json'), 'utf8'));
      }
      if (browserEnabled) {
        receipt.browser.restart = await runInstalledBrowser({ origin: receipt.browser.origin, adminKey: key, artifacts, phase: 'restart' });
        if (ownerBrowserEnabled) {
          const fixtureMode = value => { assert.ok(['expired', 'absent'].includes(value)); docker(['exec', upstream, 'node', '-e', `fetch('http://127.0.0.1:18889/daemon/control/expiry', {method:'POST', body:JSON.stringify({mode:'${value}'})}).then(response => {if (!response.ok) process.exit(1)})`]); };
          receipt.ownerBrowser.restart = await runOwnerBrowser({ origins: receipt.ownerBrowser.origins, artifacts, runtime: browserRuntime, phase: 'restart', knownSecrets: [key, ssoSecret], fixtureMode, fixtureStreamCut });
        }
      }
      if (externalKeysEnabled) {
        receipt.externalKeys = { pass: false, boundary: 'Stopped disposable state copy with synthetic external file and HTTP sources' };
        let originalStopped = false, externalStarted = false;
        try {
          docker(['stop', '--time', '20', gateway], 30000); originalStopped = true;
          docker(['volume', 'create', externalVolume]); receipt.volumes.push(externalVolume);
          receipt.externalKeys.clone = JSON.parse(docker(['run', '--rm', '--pull=never', '--name', maintenance, '--network', 'none', '--mount', `type=bind,source=${dirname(directory)},target=/tests,readonly`, '--mount', `type=volume,source=${volume},target=/source,readonly`, '--mount', `type=volume,source=${externalVolume},target=/state`, nodeImage.Id, 'node', '/tests/qualification/clone-state.mjs'], 60000));
          assert.equal(receipt.externalKeys.clone.copied, true);
          receipt.externalKeys.file = stateVolume('write-external-keys-file', externalVolume);
          assert.equal(receipt.externalKeys.file.written, true);
          receipt.retention = { pass: false };
          receipt.retention.seed = JSON.parse(docker(['run', '--rm', '--pull=never', '--name', maintenance, '--network', 'none', '--mount', `type=bind,source=${dirname(directory)},target=/tests,readonly`, '--mount', `type=bind,source=${artifacts},target=/artifacts`, '--mount', `type=volume,source=${externalVolume},target=/state`, nodeImage.Id, 'node', '/tests/qualification/retention-fixture.mjs', 'seed'], 60000));
          assert.equal(receipt.retention.seed.seeded, true);
          startGateway(gatewayImage.Id, externalVolume, externalGateway, encryptionKey, [
            '-e', 'LLMGW_EXTERNAL_KEYS_FILE=/state/external-keys.json',
            '-e', 'LLMGW_EXTERNAL_KEYS_URL=http://upstream:18889/external-keys',
            '-e', 'LLMGW_EXTERNAL_KEYS_HTTP_TOKEN=fixture-external-source-token',
            '-e', 'LLMGW_EXTERNAL_KEYS_REFRESH_INTERVAL=500ms',
            '-e', 'LLMGW_EXTERNAL_KEYS_MAX_STALENESS=5s',
            '-e', 'LLMGW_RETENTION_USAGE_DAYS=0',
            '-e', 'LLMGW_RETENTION_AUDIT_DAYS=invalid',
            '-e', 'LLMGW_RETENTION_DELIVERED_OUTBOX_DAYS=10',
          ]); externalStarted = true; receipt.containers.push(externalGateway);
          try { docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + key, upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--external-client=run'], 90000); }
          catch (error) { if (!existsSync(join(artifacts, 'external-keys-results.json'))) throw error; }
          const verified = JSON.parse(readFileSync(join(artifacts, 'external-keys-results.json'), 'utf8'));
          receipt.externalKeys.cases = verified.cases; receipt.externalKeys.pass = verified.pass === true;
        } catch (error) { receipt.externalKeys.error = redact(error.message); }
        finally {
          if (externalStarted) docker(['stop', '--time', '20', externalGateway], 30000);
          if (receipt.retention?.seed?.seeded) {
            try { docker(['run', '--rm', '--pull=never', '--name', maintenance, '--network', 'none', '--mount', `type=bind,source=${dirname(directory)},target=/tests,readonly`, '--mount', `type=bind,source=${artifacts},target=/artifacts`, '--mount', `type=volume,source=${externalVolume},target=/state`, nodeImage.Id, 'node', '/tests/qualification/retention-fixture.mjs', 'verify'], 60000); }
            catch (error) { receipt.retention.error = redact(error.message); }
            if (existsSync(join(artifacts, 'retention-results.json'))) receipt.retention = { ...receipt.retention, ...JSON.parse(readFileSync(join(artifacts, 'retention-results.json'), 'utf8')) };
          }
          if (originalStopped) docker(['restart', gateway], 30000);
        }
      }
    }
    if (profile === 'upgrade') {
      docker(['stop', '--time', '20', gateway], 30000);
      receipt.archive = { producerImageId: baselineImage.Id, consumerImageId: gatewayImage.Id, cases: [] };
      const archiveCase = async (name, run) => {
        try { await run(); receipt.archive.cases.push({ name, pass: true }); }
        catch (error) { receipt.archive.cases.push({ name, pass: false, error: redact(error.message) }); throw error; }
      };
      const archiveCli = (selectedImage, state, args, source = false) => docker(['run', '--rm', '--pull=never', '--name', maintenance, '--network', 'none', '--mount', `type=volume,source=${state},target=/state`, ...(source ? ['--mount', `type=volume,source=${archiveVolume},target=/backup,readonly`] : []), '-e', 'LLMGW_STATE_DIR=/state', '-e', 'LLMGW_CONFIG=/state/config.yaml', '-e', 'LLMGW_AUTODISCOVER_LOCAL=0', '-e', 'LLMGW_CREDENTIAL_ENCRYPTION_KEY=' + encryptionKey, selectedImage, 'backup', ...args], 60000);
      const refuseArchive = (args, expected) => {
        let refused;
        try { archiveCli(gatewayImage.Id, archiveRestoredVolume, args, true); }
        catch (error) { refused = { exitCode: error.status, output: redact(String(error.stdout ?? '') + String(error.stderr ?? '')) }; }
        assert.equal(refused?.exitCode, 1, 'the installed CLI must reject the invalid operation');
        assert.match(refused.output, expected);
        assert.doesNotMatch(refused.output, /permission denied|no such file|not found/i, 'an unavailable fixture is not a validation result');
        stateVolume('verify-empty', archiveRestoredVolume, true);
        return refused;
      };
      docker(['volume', 'create', archiveVolume]); receipt.volumes.push(archiveVolume);
      stateVolume('restore', archiveVolume);
      docker(['volume', 'create', archiveRestoredVolume]); receipt.volumes.push(archiveRestoredVolume);
      stateVolume('initialize', archiveRestoredVolume);
      await archiveCase('builtin-backup-create-inspect', async () => {
        receipt.archive.created = archiveCli(baselineImage.Id, archiveVolume, ['create', '/state/backups/qualification.tar.gz']);
        receipt.archive.inspected = archiveCli(gatewayImage.Id, archiveVolume, ['inspect', '/state/backups/qualification.tar.gz']);
        assert.match(receipt.archive.created, /backup created:/);
        assert.match(receipt.archive.inspected, /format: 1/);
        assert.match(receipt.archive.inspected, /schema: [1-9]\d*/);
        assert.match(receipt.archive.inspected, /credential_key: matches/);
        receipt.archive.file = stateVolume('retain-archive', archiveVolume, true);
      });
      await archiveCase('builtin-backup-excludes-request-logs', async () => {
        const baselineManifest = JSON.parse(readFileSync(join(artifacts, 'pre-upgrade-state', 'manifest.json'), 'utf8'));
        assert.ok(baselineManifest.entries.some(entry => entry.path === 'requests.jsonl'), 'the protected original must actually contain a request log to establish exclusion');
        const entries = docker(['run', '--rm', '--pull=never', '--name', maintenance, '--network', 'none', '--mount', `type=bind,source=${artifacts},target=/artifacts,readonly`, receipt.nodeImageId, 'tar', '-tzf', '/artifacts/gateway-backup.tar.gz'], 20000).trim().split(/\r?\n/);
        assert.ok(entries.length > 0); assert.ok(!entries.some(entry => /(?:^|\/)requests\.jsonl$|\.log(?:\.|$)/.test(entry)), 'the archive must omit the existing operational request log');
        receipt.archive.logExcluded = true;
      });
      await archiveCase('builtin-restore-requires-force', async () => {
        receipt.archive.missingForce = refuseArchive(['restore', '/backup/backups/qualification.tar.gz'], /usage: llmgw backup restore/);
      });
      await archiveCase('builtin-corrupt-backup-refused', async () => {
        receipt.archive.corruptFixture = stateVolume('corrupt-archive', archiveVolume);
        receipt.archive.corrupt = refuseArchive(['restore', '/backup/backups/corrupt.tar.gz', '--force'], /backup|compression|EOF/i);
      });
      await archiveCase('builtin-future-schema-refused', async () => {
        receipt.archive.futureFixture = stateVolume('future-schema-archive', archiveVolume);
        receipt.archive.futureSchema = refuseArchive(['restore', '/backup/backups/future-schema.tar.gz', '--force'], /backup schema is newer than this binary supports/);
      });
      await archiveCase('builtin-backup-restored-state', async () => {
        receipt.archive.restored = archiveCli(gatewayImage.Id, archiveRestoredVolume, ['restore', '/backup/backups/qualification.tar.gz', '--force'], true);
        assert.match(receipt.archive.restored, /backup restored/);
        assert.match(receipt.archive.restored, /credential_key: matches/);
        startGateway(gatewayImage.Id, archiveRestoredVolume, archiveGateway);
        receipt.containers.push(archiveGateway);
        receipt.archive.firstStart = stateClient('archive');
        assert.equal(receipt.archive.firstStart.pass, true);
        docker(['restart', archiveGateway], 30000);
        receipt.archive.restart = stateClient('archive-restart');
        assert.equal(receipt.archive.restart.pass, true);
        docker(['stop', '--time', '20', archiveGateway], 30000);
      });
      receipt.archive.pass = receipt.archive.cases.length === 6 && receipt.archive.cases.every(item => item.pass);
      docker(['volume', 'create', rollbackVolume]); receipt.volumes.push(rollbackVolume);
      receipt.upgrade.rollback = { imageId: baselineImage.Id, volume: rollbackVolume, restored: stateVolume('restore', rollbackVolume) };
      startGateway(baselineImage.Id, rollbackVolume, rollbackGateway);
      receipt.containers.push(rollbackGateway);
      receipt.upgrade.rollback.firstStart = stateClient('rollback');
      receipt.upgrade.rollback.cli = { version: docker(['exec', rollbackGateway, '/llmgw', 'version']).trim(), health: docker(['exec', rollbackGateway, '/llmgw', 'health']).trim() };
      assert.equal(receipt.upgrade.rollback.cli.version, receipt.installed.seedCli.version);
      assert.deepEqual(receipt.upgrade.rollback.firstStart.build, receipt.installed.seed.build);
      docker(['restart', rollbackGateway], 30000);
      receipt.upgrade.rollback.restart = stateClient('rollback-restart');
      assert.deepEqual(receipt.upgrade.rollback.restart.build, receipt.installed.seed.build);
      docker(['stop', '--time', '20', rollbackGateway], 30000);
      docker(['volume', 'create', rekeyVolume]); receipt.volumes.push(rekeyVolume);
      const restoredForRekey = stateVolume('restore', rekeyVolume);
      rotatedEncryptionKey = randomBytes(32).toString('base64');
      receipt.rekey = { source: 'restored copy of the sealed earlier-image snapshot', volume: rekeyVolume, restored: restoredForRekey.verified, cases: [] };
      const rekeyCase = async (name, run) => {
        try { await run(); receipt.rekey.cases.push({ name, pass: true }); }
        catch (error) { receipt.rekey.cases.push({ name, pass: false, error: redact(error.message) }); throw error; }
      };
      await rekeyCase('builtin-rekey-encrypts-preserved-credentials-on-a-copy', async () => {
        assert.equal(receipt.rekey.restored, true);
        const rekeyed = docker(['run', '--rm', '--pull=never', '--name', maintenance, '--network', 'none', '--mount', `type=volume,source=${rekeyVolume},target=/state`, '-e', 'LLMGW_STATE_DIR=/state', '-e', 'LLMGW_CONFIG=/state/config.yaml', '-e', 'LLMGW_AUTODISCOVER_LOCAL=0', '-e', 'LLMGW_CREDENTIAL_ENCRYPTION_KEY=' + encryptionKey, '-e', 'LLMGW_NEW_CREDENTIAL_ENCRYPTION_KEY=' + rotatedEncryptionKey, gatewayImage.Id, 'credentials', 'rekey'], 60000);
        assert.match(rekeyed, /credentials re-encrypted/);
        receipt.rekey.cli = { exitCode: 0, records: [...rekeyed.matchAll(/^([a-z_]+): (\d+)$/gm)].map(match => ({ table: match[1], count: Number(match[2]) })) };
        startGateway(gatewayImage.Id, rekeyVolume, rekeyGateway, rotatedEncryptionKey); receipt.containers.push(rekeyGateway);
        receipt.rekey.firstStart = stateClient('rekey'); assert.equal(receipt.rekey.firstStart.pass, true);
      });
      await rekeyCase('builtin-rekey-refuses-active-gateway-state', async () => {
        let liveLockRefusal;
        try { docker(['run', '--rm', '--pull=never', '--name', maintenance, '--network', 'none', '--mount', `type=volume,source=${rekeyVolume},target=/state`, '-e', 'LLMGW_STATE_DIR=/state', '-e', 'LLMGW_CONFIG=/state/config.yaml', '-e', 'LLMGW_AUTODISCOVER_LOCAL=0', '-e', 'LLMGW_CREDENTIAL_ENCRYPTION_KEY=' + rotatedEncryptionKey, '-e', 'LLMGW_NEW_CREDENTIAL_ENCRYPTION_KEY=' + encryptionKey, gatewayImage.Id, 'credentials', 'rekey'], 30000); }
        catch (error) { liveLockRefusal = { status: error.status, detail: redact(String(error.stdout ?? '') + String(error.stderr ?? '')) }; }
        assert.equal(liveLockRefusal?.status, 1); assert.match(liveLockRefusal.detail, /gateway state is in use/);
        receipt.rekey.liveLockRefusal = { exitCode: 1, noMutation: true };
      });
      await rekeyCase('old-key-refused-after-rekey-and-new-key-recovers-preserved-state', async () => {
        docker(['stop', '--time', '20', rekeyGateway], 30000); docker(['rm', '-v', rekeyGateway]);
        startGateway(gatewayImage.Id, rekeyVolume, wrongKeyGateway); receipt.containers.push(wrongKeyGateway);
        const rejectedExit = docker(['wait', wrongKeyGateway], 30000).trim();
        const rejectedLogs = spawnSync('docker', ['logs', wrongKeyGateway], { encoding: 'utf8', timeout: 10000 });
        const rejectedLog = redact(String(rejectedLogs.stdout ?? '') + String(rejectedLogs.stderr ?? ''));
        assert.notEqual(rejectedExit, '0'); assert.match(rejectedLog, /credential.*key|key.*credential/i);
        receipt.rekey.oldKeyRefused = { exitCode: Number(rejectedExit), safeError: true };
        docker(['rm', '-v', wrongKeyGateway]);
        startGateway(gatewayImage.Id, rekeyVolume, rekeyGateway, rotatedEncryptionKey);
        receipt.rekey.restart = stateClient('rekey-restart');
        assert.equal(receipt.rekey.restart.pass, true);
      });
      receipt.rekey.pass = receipt.rekey.cases.length === 3 && receipt.rekey.cases.every(row => row.pass);
    }
  } catch (error) { receipt.error = redact(error.message); }
  finally {
    if (captureDir) {
      const records = readdirSync(captureDir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(captureDir, name), 'utf8')));
      receipt.capture = { directory: captureDir, selectedRequestIDs: captureIDs, attempts: records.map(record => ({ requestId: record.request_id, host: record.host, path: record.path, status: record.status, complete: record.complete, requestBytes: record.request_bytes, responseBytes: record.response_bytes, truncated: Boolean(record.request_truncated || record.response_truncated) })) };
      receipt.capture.pass = records.length > 0 && records.every(record => captureIDs.includes(record.request_id) && record.complete && !record.request_truncated && !record.response_truncated);
    }
    if (receipt.upgrade?.snapshot) {
      try {
        // Neither the candidate nor the functional suite ever mounts the original baseline.
        const proof = JSON.parse(docker(['run', '--rm', '--pull=never', '--name', maintenance, '--network', 'none', '--mount', `type=bind,source=${dirname(directory)},target=/tests,readonly`, '--mount', `type=bind,source=${artifacts},target=/artifacts,readonly`, '--mount', `type=volume,source=${baselineVolume},target=/state,readonly`, '-e', 'SNAPSHOT_SHA256=' + receipt.upgrade.snapshot.manifestSha256, receipt.nodeImageId, 'node', '/tests/qualification/state-volume.mjs', 'verify-baseline'], 60000));
        receipt.upgrade.snapshot.intact = proof.verified;
      } catch (error) { receipt.upgrade.snapshot.intact = false; receipt.error ??= redact(error.message); }
    }
    for (const name of [...new Set([gateway, rollbackGateway, archiveGateway, rekeyGateway, wrongKeyGateway, externalGateway, browserProxy, upstream, maintenance, ...receipt.containers])]) {
      try {
        const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 10000 });
        const role = name.endsWith('-gateway') ? 'gateway' : name.endsWith('-rollback') ? 'rollback' : name.endsWith('-archive') ? 'archive' : name.endsWith('-browser-proxy') ? 'browser-proxy' : name.endsWith('-upstream') ? 'upstream' : 'maintenance';
        writeFileSync(join(artifacts, role + '.log'), redact(logs.stdout + logs.stderr));
        const state = JSON.parse(docker(['inspect', name]))[0].State;
        (receipt.containerStates ??= {})[role] = { running: state.Running, exitCode: state.ExitCode, error: state.Error };
      } catch { /* startup failure */ }
       try { docker(['rm', '-fv', name]); } catch { /* absent */ }
    }
    try { docker(['network', 'rm', network]); receipt.cleaned = true; } catch { receipt.cleaned = false; }
    if (receipt.browser?.network) {
      try { docker(['network', 'rm', browserNetwork]); } catch { receipt.cleaned = false; }
    }
    for (const stateVolume of receipt.volumes) {
      try { docker(['volume', 'rm', stateVolume]); } catch { receipt.cleaned = false; }
    }
    receipt.pass = !receipt.error && receipt.results?.pass === true && receipt.cleaned && (!captureDir || receipt.capture?.pass === true) && (profile === 'replay' || (receipt.installed?.firstStart?.pass === true && receipt.installed?.restart?.pass === true)) && (!browserEnabled || (receipt.browser?.firstStart?.pass === true && receipt.browser?.restart?.pass === true)) && (!ownerBrowserEnabled || (receipt.ownerBrowser?.firstStart?.pass === true && receipt.ownerBrowser?.restart?.pass === true)) && (!clientsEnabled || (receipt.installedClients?.pass === true && receipt.results.upstreamMetrics?.clients?.calls?.length >= 8 && receipt.results.upstreamMetrics.clients.cancelled >= 1)) && (!shutdownEnabled || receipt.shutdown?.pass === true) && (!externalKeysEnabled || (receipt.externalKeys?.pass === true && receipt.retention?.pass === true)) && (!receipt.mediaRestartRequired || receipt.mediaRestart?.pass === true) && (!receipt.extensionRestartRequired || receipt.extensionRestart?.pass === true) && (!receipt.operationalRestartRequired || receipt.operationalRestart?.pass === true) && (!receipt.metricsRestartRequired || receipt.metricsRestart?.pass === true) && (!receipt.callerRateRestartRequired || receipt.callerRateRestart?.pass === true) && (!receipt.discoveryRestartRequired || (receipt.discoveryAged?.aged === true && receipt.discoveryRestart?.pass === true)) && (!receipt.transparentRestartRequired || (receipt.transparentTrusted?.trustedCatalogInjected === true && receipt.transparentRestart?.pass === true)) && (!receipt.logInspectionRequired || receipt.logInspection?.inspected === true) && (profile !== 'upgrade' || (receipt.archive?.pass === true && receipt.rekey?.pass === true && receipt.upgrade?.snapshot?.intact === true && receipt.upgrade?.rollback?.firstStart?.pass === true && receipt.upgrade?.rollback?.restart?.pass === true));
    writeFileSync(join(artifacts, 'docker-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
  console.log(JSON.stringify({ pass: receipt.pass, profile, artifacts, cases: receipt.results?.cases, installed: receipt.installed, error: receipt.error, setupError: receipt.results?.setupError }));
  if (!receipt.pass) process.exitCode = 1;
}

if (process.argv.includes('--client')) await client();
else if (option('state')) await runInstalledState(option('state'));
else if (option('media-recovery')) await runInstalledMediaRecovery(option('media-recovery'));
else if (option('extension-recovery')) await runInstalledExtensionRecovery(option('extension-recovery'));
else if (option('operational-recovery')) await runInstalledOperationalRecovery(option('operational-recovery'));
else if (option('metrics-recovery')) await runInstalledMetricsRecovery(option('metrics-recovery'));
else if (option('shutdown-client')) await runShutdownClient(option('shutdown-client'));
else if (option('rate-recovery')) await runInstalledRateRecovery(option('rate-recovery'));
else if (option('discovery-recovery')) await runInstalledDiscoveryRecovery(option('discovery-recovery'));
else if (option('transparent-recovery')) await runInstalledTransparentRecovery(option('transparent-recovery'));
else if (option('external-client')) await runInstalledExternalKeys(option('external-client'));
else await orchestrate();
