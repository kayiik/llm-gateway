import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runInstalledClients({ origin, adminKey, artifacts, runtime }) {
  const seed = JSON.parse(readFileSync(join(artifacts, 'owner-seed-private.json'), 'utf8'));
  let key = seed.keys.a.token, clientKeyID;
  const secrets = [adminKey, key, 'fixture-client-upstream-key'];
  const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[temporary-key]'), String(value));
  const result = { boundary: 'Real pinned CLI and SDK processes against the installed Gateway and controlled native provider endpoints', pass: false, cases: [], runtimeVersions: {} };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = redact(error.message); } };
  const admin = async (path, body) => {
    const response = await fetch(origin + '/admin/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) });
    const text = await response.text(); assert.ok(response.ok, path + ': ' + response.status + ' ' + redact(text)); return JSON.parse(text);
  };
  const execute = (command, args, env, timeout = 90000) => {
    const run = spawnSync(command, args, { cwd: artifacts, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(run.error, undefined, 'client command could not be started');
    assert.equal(run.status, 0, 'client process failed with exit ' + run.status + ': ' + redact((run.stderr ?? '').slice(-550)));
    return run.stdout;
  };
  const model = { chat: 'sdk-openai/fixture-client-chat', responses: 'sdk-openai/fixture-client-responses', messages: 'sdk-messages/fixture-client-messages' };

  await test('installed-project-key-discovers-native-client-models-on-both-upstream-wires', async row => {
    for (const [id, registry_id, url] of [['sdk-openai', 'openai', 'openai'], ['sdk-messages', 'anthropic', 'anthropic']]) {
      await admin('providers', { id, registry_id, base_url: `http://upstream:18889/clients/${url}${url === 'openai' ? '/v1' : ''}`, api_key: 'fixture-client-upstream-key' });
      if (id === 'sdk-openai') await admin(`principals/${seed.actors.a.id}/connections`, { provider_id: id, connection_name: 'client-owner', credential_kind: 'api_key', secret: 'fixture-client-upstream-key', make_default: true });
      await admin(`providers/${id}/refresh?principal_id=${seed.actors.a.id}`, {});
    }
    const issued = await admin('keys', { project_id: seed.project.id, principal_id: seed.actors.a.id, name: 'Disposable installed client key', daily_requests: 100 });
    key = issued.token; clientKeyID = issued.key.id; secrets.push(key);
    const response = await fetch(origin + '/v1/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
    const ids = (await response.json()).data.map(item => item.id);
    for (const selected of Object.values(model)) assert.ok(ids.includes(selected), selected + ' must be visible to the actual client key');
    row.modelCount = Object.values(model).length;
  });
  await test('openai-sdk-native-chat-responses-stream-and-model-list', async row => {
    const location = join(runtime, 'node_modules/openai/index.mjs'); assert.ok(existsSync(location));
    const { default: OpenAI } = await import(pathToFileURL(location).href);
    result.runtimeVersions.openai = JSON.parse(readFileSync(join(runtime, 'node_modules/openai/package.json'), 'utf8')).version;
    const sdk = new OpenAI({ apiKey: key, baseURL: origin + '/v1', maxRetries: 0, timeout: 18000 });
    const models = await sdk.models.list(); assert.ok(models.data.some(item => item.id === model.responses));
    const chat = await sdk.chat.completions.create({ model: model.chat, messages: [{ role: 'user', content: 'Return the controlled answer' }] });
    assert.equal(chat.choices[0].message.content, 'fixture-client-ok');
    const response = await sdk.responses.create({ model: model.responses, input: 'Return the controlled answer' });
    assert.equal(response.output[0].content[0].text, 'fixture-client-ok');
    const streamed = await sdk.responses.create({ model: model.responses, input: 'Stream the controlled answer', stream: true });
    const events = []; for await (const event of streamed) events.push(event);
    assert.equal(events.filter(event => event.type === 'response.completed').length, 1); assert.equal(events.find(event => event.type === 'response.completed').response.output[0].content[0].text, 'fixture-client-ok');
    row.nativeCalls = 3; row.streamingTerminals = 1;
  });
  await test('anthropic-sdk-native-messages-stream-and-token-count', async row => {
    const location = join(runtime, 'node_modules/@anthropic-ai/sdk/index.mjs'); assert.ok(existsSync(location));
    const { default: Anthropic } = await import(pathToFileURL(location).href);
    result.runtimeVersions.anthropic = JSON.parse(readFileSync(join(runtime, 'node_modules/@anthropic-ai/sdk/package.json'), 'utf8')).version;
    const sdk = new Anthropic({ apiKey: key, baseURL: origin, maxRetries: 0, timeout: 18000 });
    const messages = [{ role: 'user', content: 'Return the controlled answer' }];
    const response = await sdk.messages.create({ model: model.messages, max_tokens: 32, messages });
    assert.equal(response.content[0].text, 'fixture-client-ok');
    const count = await sdk.messages.countTokens({ model: model.messages, messages }); assert.equal(count.input_tokens, 2);
    const streamed = await sdk.messages.stream({ model: model.messages, max_tokens: 32, messages }).finalMessage();
    assert.equal(streamed.content[0].text, 'fixture-client-ok');
    const tools = [{ name: 'lookup', description: 'Controlled lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }];
    const first = await sdk.messages.create({ model: model.messages, max_tokens: 32, messages, tools });
    assert.equal(first.stop_reason, 'tool_use'); const use = first.content.find(block => block.type === 'tool_use');
    assert.equal(use.id, 'tool_client_fixture'); assert.deepEqual(use.input, { q: 'fixture' });
    const continuation = [...messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'result-fixture' }] }];
    const final = await sdk.messages.create({ model: model.messages, max_tokens: 32, messages: continuation, tools }); assert.equal(final.content[0].text, 'fixture-client-ok');
    row.nativeCalls = 4; row.counts = 1; row.toolCalls = 1;
  });
  await test('openai-sdk-cancellation-closes-one-open-stream-without-terminal-replay', async row => {
    const { default: OpenAI } = await import(pathToFileURL(join(runtime, 'node_modules/openai/index.mjs')).href);
    const sdk = new OpenAI({ apiKey: key, baseURL: origin + '/v1', maxRetries: 0, timeout: 18000 });
    const controller = new AbortController();
    const stream = await sdk.responses.create({ model: model.responses, input: 'cancel after the opening event', stream: true }, { signal: controller.signal });
    let opened = false, completed = false;
    try { for await (const event of stream) {
      opened ||= event.type === 'response.created'; completed ||= event.type === 'response.completed';
      if (opened) controller.abort();
    } } catch (error) { assert.ok(controller.signal.aborted, error.message); }
    assert.equal(opened, true); assert.equal(completed, false, 'an aborted SDK stream must not receive the final answer'); row.openedThenCancelled = true;
  });
  await test('codex-cli-native-responses-uses-only-the-isolated-project-key', async row => {
    const home = join(artifacts, 'codex-home'); mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'config.toml'), `model_provider = "llmgw"\nmodel = "${model.responses}"\n[model_providers.llmgw]\nname = "local-gateway-fixture"\nbase_url = "${origin}/v1"\nenv_key = "LLMGW_CLIENT_PROJECT_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
    const env = { ...process.env, CODEX_HOME: home, LLMGW_CLIENT_PROJECT_KEY: key, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GH_TOKEN: '', GITHUB_TOKEN: '', CODEX_DISABLE_TELEMETRY: '1' };
    result.runtimeVersions.codex = execute('codex', ['--version'], env, 10000).trim();
    const output = execute('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', model.responses, 'Reply with fixture-client-ok. Do not call tools.'], env);
    assert.ok(output.includes('fixture-client-ok'), 'Codex must surface the actual controlled native response'); row.nativeAnswer = true;
  });
  await test('copilot-cli-byok-native-responses-uses-only-the-isolated-project-key', async row => {
    const executable = join(runtime, 'node_modules/@github/copilot-win32-x64/copilot.exe'); assert.ok(existsSync(executable));
    const home = join(artifacts, 'copilot-home'); mkdirSync(home, { mode: 0o700 });
    const env = { ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: home, COPILOT_PROVIDER_BASE_URL: origin + '/v1', COPILOT_PROVIDER_API_KEY: key,
      COPILOT_MODEL: 'fixture-client-responses', COPILOT_PROVIDER_WIRE_MODEL: model.responses, COPILOT_PROVIDER_WIRE_API: 'responses', GH_TOKEN: '', GITHUB_TOKEN: '', COPILOT_GITHUB_TOKEN: '' };
    result.runtimeVersions.copilot = execute(executable, ['--version'], env, 12000).trim();
    const output = execute(executable, ['--trust-folder', '--no-ask-user', '--available-tools=__llmgw_no_tools__', '-p', 'Reply with fixture-client-ok and do not call tools.'], env);
    assert.ok(output.includes('fixture-client-ok'), 'Copilot BYOK must surface the controlled native response'); row.nativeAnswer = true;
  });
  await test('revoked-disposable-client-key-is-refused-before-either-sdk-dispatches', async row => {
    assert.ok(clientKeyID, 'the client key must be disposable, not an original preserved owner key');
    const revoked = await fetch(origin + '/admin/api/keys?id=' + encodeURIComponent(clientKeyID), { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminKey }, signal: AbortSignal.timeout(5000) }); assert.equal(revoked.status, 200); await revoked.json();
    const { default: OpenAI } = await import(pathToFileURL(join(runtime, 'node_modules/openai/index.mjs')).href);
    const { default: Anthropic } = await import(pathToFileURL(join(runtime, 'node_modules/@anthropic-ai/sdk/index.mjs')).href);
    const openai = new OpenAI({ apiKey: key, baseURL: origin + '/v1', maxRetries: 0, timeout: 10000 });
    const anthropic = new Anthropic({ apiKey: key, baseURL: origin, maxRetries: 0, timeout: 10000 });
    await assert.rejects(openai.chat.completions.create({ model: model.chat, messages: [{ role: 'user', content: 'revoked' }] }), error => error.status === 401);
    await assert.rejects(anthropic.messages.create({ model: model.messages, max_tokens: 16, messages: [{ role: 'user', content: 'revoked' }] }), error => error.status === 401);
    row.clientStatus = 401; row.clientKeysRevoked = 1;
  });
  result.pass = result.cases.length === 7 && result.cases.every(row => row.pass);
  writeFileSync(join(artifacts, 'installed-clients.json'), redact(JSON.stringify(result, null, 2)) + '\n', { mode: 0o600 });
  return result;
}
