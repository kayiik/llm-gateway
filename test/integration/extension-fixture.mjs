import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mediaWAV } from './media-fixture.mjs';

const conversation = JSON.parse(readFileSync(new URL('./fixtures/conversation.json', import.meta.url), 'utf8'));
const surfaces = { chat: 'chat_completions', responses: 'responses', messages: 'messages', voice: 'audio_speech' };
const paths = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages', voice: '/v1/audio/speech' };

function model(id, wire, { stream = true, unknown = false } = {}) {
  const state = key => unknown ? 'unknown' : key === wire ? 'supported' : 'unsupported';
  return {
    id, object: 'model', ...(unknown ? {} : { supported_apis: [paths[wire]], wire_preservation: { [surfaces[wire]]: 'supported' } }),
    capabilities: {
      schema_version: 1,
      operations: { chat: unknown ? 'unknown' : wire === 'voice' ? 'unsupported' : 'supported', embeddings: state('embedding'), image: state('image'), audio_in: state('audio_in'), audio_out: state('voice'), video: state('video'), token_count: 'unsupported' },
      surfaces: { chat_completions: state('chat'), responses: state('responses'), messages: state('messages') },
      tools: unknown ? 'unknown' : wire === 'voice' ? 'unsupported' : 'supported', streaming: unknown ? 'unknown' : stream ? 'supported' : 'unsupported', reasoning: 'unknown', structured_output: 'unknown', stateful_responses: id === 'private-responses' ? 'supported' : 'unsupported',
      provenance: unknown ? { source: 'inferred', confidence: 'low' } : { source: 'upstream_reported', confidence: 'high' },
      freshness: { discovered_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() },
    },
  };
}

function reply(wire, body, selected) {
  const tools = body.tools?.length > 0;
  const final = !tools || JSON.stringify(body.messages ?? body.input).includes(conversation.tool.result);
  const { tool, text } = conversation;
  const message = final ? { role: 'assistant', content: text } : { role: 'assistant', content: null, tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }] };
  const content = final ? [{ type: 'text', text }] : [{ type: 'tool_use', id: tool.id, name: tool.name, input: JSON.parse(tool.arguments) }];
  const output = final ? [{ type: 'message', id: 'extension-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] : [{ type: 'function_call', id: 'extension-function', call_id: tool.id, name: tool.name, arguments: tool.arguments, status: 'completed' }];
  const usage = final ? { input_tokens: 3, output_tokens: 2, total_tokens: 5 } : conversation.usage.initial;
  const json = wire === 'chat'
    ? { id: 'extension-chat', object: 'chat.completion', model: selected, choices: [{ index: 0, message, finish_reason: final ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens } }
    : wire === 'messages' ? { id: 'extension-message', type: 'message', role: 'assistant', model: selected, content, stop_reason: final ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } }
      : { id: 'extension-response', object: 'response', created_at: 1, model: selected, status: 'completed', output, usage, ...(body.metadata?.fixture_instructions ? { instructions: body.metadata.fixture_instructions } : {}) };
  const frames = [];
  const event = (type, value) => frames.push(`${type ? 'event: ' + type + '\n' : ''}data: ${JSON.stringify(value)}\n\n`);
  if (wire === 'chat') {
    event('', { id: json.id, object: 'chat.completion.chunk', model: selected, choices: [{ index: 0, delta: message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : message, finish_reason: null }] });
    event('', { id: json.id, object: 'chat.completion.chunk', model: selected, choices: [{ index: 0, delta: {}, finish_reason: final ? 'stop' : 'tool_calls' }] });
    event('', { id: json.id, object: 'chat.completion.chunk', model: selected, choices: [], usage: json.usage }); frames.push('data: [DONE]\n\n');
  } else if (wire === 'messages') {
    event('message_start', { type: 'message_start', message: { ...json, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } });
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: final ? { type: 'text', text: '' } : { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: final ? { type: 'text_delta', text } : { type: 'input_json_delta', partial_json: tool.arguments } });
    event('content_block_stop', { type: 'content_block_stop', index: 0 }); event('message_delta', { type: 'message_delta', delta: { stop_reason: json.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }); event('message_stop', { type: 'message_stop' });
  } else {
    event('response.created', { type: 'response.created', response: { ...json, status: 'in_progress', output: [], usage: null } });
    event('response.completed', { type: 'response.completed', response: json });
  }
  return { json, frames };
}

export function createExtensionFixture(metrics, { root = '/daemon', quota = false } = {}) {
  const flows = new Map(); let sequence = 0, expiryMode = 'absent', allowanceMode = 'fraction';
  const metric = quota ? 'extensionQuota' : 'extension';
  const state = () => metrics[metric] ??= { info: 0, models: [], calls: [], oauthStarts: 0, oauthPolls: 0, allowanceReads: 0, rejected: 0 };
  return async (req, res, path) => {
    if (path === root + '/control/expiry' && req.method === 'POST') { let raw = ''; for await (const part of req) raw += part; expiryMode = JSON.parse(raw).mode; res.end(JSON.stringify({ mode: expiryMode })); return true; }
    if (quota && path === root + '/control/allowance' && req.method === 'POST') { let raw = ''; for await (const part of req) raw += part; allowanceMode = JSON.parse(raw).mode; assert.ok(['fraction', 'zero', 'short', 'unknown', 'unsupported'].includes(allowanceMode)); res.end(JSON.stringify({ mode: allowanceMode })); return true; }
    const prefix = root + '/extension/v1/'; if (!path.startsWith(prefix)) return false;
    const tail = path.slice(prefix.length), status = state(); res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer fixture-extension-secret') { res.writeHead(401); res.end('{"error":"controlled shared-secret refusal"}'); return true; }
    if (tail === 'info') {
      status.info++;
      res.end(JSON.stringify({ version: '0.0.4', providers: quota ? [
        { id: 'google_antigravity', name: 'Controlled private advisory account', surfaces: ['chat_completions'], credential: 'oauth', has_oauth: true, has_refresh: true, oauth_methods: ['device'] },
      ] : [
        { id: 'fixture_declared', name: 'Controlled native capabilities', surfaces: Object.values(surfaces), credential: 'none', has_oauth: false, has_refresh: false },
        { id: 'google_antigravity', name: 'Controlled nonstream Chat declaration', surfaces: ['chat_completions'], credential: 'none', has_oauth: false, has_refresh: false },
        { id: 'fixture_oauth', name: 'Controlled private device sign-in', surfaces: ['chat_completions'], credential: 'oauth', has_oauth: true, has_refresh: true, oauth_methods: ['device'] },
        { id: 'fixture_oauth_alt', name: 'Other private sign-in binding', surfaces: ['chat_completions'], credential: 'oauth', has_oauth: true, has_refresh: true, oauth_methods: ['device'] },
        { id: 'github_copilot', name: 'Controlled Copilot credential boundary', surfaces: ['chat_completions'], credential: 'oauth', has_oauth: true, has_refresh: true, oauth_methods: ['device'] },
      ] })); return true;
    }
    const match = tail.match(/^([^/]+)\/(models|invoke|stream|oauth\/(?:start|poll|complete)|refresh|allowance)$/);
    if (!match) { res.writeHead(404); res.end('{"error":"undeclared controlled daemon surface"}'); return true; }
    const provider = match[1], operation = match[2];
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    if (operation === 'oauth/start') {
      status.oauthStarts++; const code = 'controlled-device-' + (++sequence); flows.set(code, { polls: 0, mode: expiryMode });
      res.end(JSON.stringify({ authorization: { UserCode: 'FIXTURE-' + sequence, VerificationURI: 'https://verification.example.test/device', Interval: 1, ExpiresIn: expiryMode === 'expired' ? 1 : 60000000000, Secrets: { DeviceCode: code } } })); return true;
    }
    if (operation === 'oauth/poll') {
      status.oauthPolls++; const code = body.flow?.Secrets?.DeviceCode; const flow = flows.get(code);
      if (!flow) { res.writeHead(400); res.end('{"error":"unknown controlled flow"}'); return true; }
      flow.polls++;
      if (flow.polls === 1) { res.end('{"result":{"Status":"pending"}}'); return true; }
      if (flow.mode === 'failure') { res.writeHead(500); res.end('{"error":"controlled completion failure"}'); return true; }
      const record = { AccessToken: 'fixture-extension-owner-token', RefreshToken: 'fixture-extension-refresh', TokenType: 'Bearer', AccountID: 'fixture-account', Metadata: { fixture_provider: provider } };
      if (flow.mode === 'zero') record.Expiry = '0001-01-01T00:00:00Z';
      if (flow.mode === 'negative') record.Expiry = '1969-12-31T23:59:59Z';
      res.end(JSON.stringify({ result: { Status: 'approved', Record: record } })); return true;
    }
    if (operation === 'refresh') { res.end(JSON.stringify({ record: { ...body.record, AccessToken: 'fixture-extension-owner-token' } })); return true; }
    const privateProvider = provider.startsWith('fixture_oauth') || provider === 'github_copilot' || (quota && provider === 'google_antigravity');
    const credential = req.headers['x-credential-token'] === 'fixture-extension-shared-token' ? 'shared' : req.headers['x-credential-token'] === 'fixture-extension-owner-token' ? 'owner' : 'none';
    if (privateProvider && (credential === 'none' || (credential === 'shared' && provider !== 'github_copilot'))) { res.writeHead(401); res.end('{"error":"controlled private credential required"}'); return true; }
    if (operation === 'allowance' && quota) {
      status.allowanceReads++;
      if (allowanceMode === 'unsupported') { res.writeHead(404); res.end('{"error":"allowance is not supported"}'); return true; }
      if (allowanceMode === 'unknown') { res.end('{"status":"unknown"}'); return true; }
      const now = Date.now();
      const observation = { model_id: 'quota-chat', project_id: 'fixture-project', observed_at: new Date(now).toISOString(), remaining_fraction: allowanceMode === 'zero' ? 0 : 0.5,
        reset_at: new Date(now + (allowanceMode === 'short' ? 3000 : 3600000)).toISOString() };
      res.end(JSON.stringify({ status: 'observed', observations: [observation] })); return true;
    }
    if (operation === 'models') {
      status.models.push({ provider, credential: privateProvider ? credential : 'none' });
      const models = provider === 'fixture_declared' ? [model('chat-only', 'chat'), model('responses-only', 'responses'), model('messages-only', 'messages'), model('unknown-model', 'chat', { unknown: true }), model('voice', 'voice', { stream: false })]
        : provider === 'google_antigravity' ? [model(quota ? 'quota-chat' : 'nonstream-chat', 'chat', { stream: false })] : provider === 'fixture_oauth' ? [model('private-chat', 'chat'), model('private-responses', 'responses')] : [model('private-chat', 'chat')];
      res.end(JSON.stringify({ models })); return true;
    }
    status.calls.push({ provider, operation, surface: req.headers['x-surface'], model: req.headers['x-model'], credential: privateProvider ? credential : 'none' }); metrics.inference++;
    try {
      const selected = req.headers['x-model']; const wire = { 'chat-only': 'chat', 'responses-only': 'responses', 'messages-only': 'messages', 'private-chat': 'chat', 'private-responses': 'responses', 'nonstream-chat': 'chat', 'quota-chat': 'chat', voice: 'voice' }[selected];
      assert.ok(wire); assert.equal(req.headers['x-surface'], surfaces[wire]);
      if (!privateProvider) assert.equal(req.headers['x-credential-token'] ?? '', '');
      for (const control of ['fallback_timeout_ms', 'affinity_key', '_fallback_timeout_ms', '_affinity_key']) assert.equal(body[control], undefined);
      if (wire === 'voice') { assert.equal(body.input, 'Hello.'); assert.equal(body.voice, 'fixture-voice'); res.setHeader('Content-Type', 'audio/wav'); res.end(mediaWAV); return true; }
      if ((selected === 'responses-only' || selected === 'private-responses') && Array.isArray(body.input)) {
        const output = body.input.filter(item => item.type === 'function_call_output');
        if (output.length) { assert.equal(output.length, 1); assert.equal(output[0].call_id, conversation.tool.id); assert.equal(output[0].output, conversation.tool.result); }
      }
      const result = reply(wire, body, selected);
      if (operation === 'stream') { assert.notEqual(selected, 'nonstream-chat'); res.setHeader('Content-Type', 'text/event-stream'); res.end(result.frames.join('')); }
      else res.end(JSON.stringify(result.json));
      return true;
    } catch { status.rejected++; res.writeHead(422); res.end('{"error":"extension native request declaration mismatch"}'); return true; }
  };
}
