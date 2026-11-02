import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRecordedReplay } from './recorded-replay.mjs';
import { assertMatrixRequest } from './streaming-tool-matrix.mjs';
import { embeddingReply } from './embeddings-matrix.mjs';
import { createRoutingFixture } from './routing-fixture.mjs';
import { createProtocolFixture } from './protocol-fixture.mjs';
import { createMediaFixture } from './media-fixture.mjs';
import { createRealtimeFixture } from './realtime-fixture.mjs';
import { createIAMFixture } from './iam-fixture.mjs';
import { createExtensionFixture } from './extension-fixture.mjs';
import { createBedrockFixture } from './bedrock-fixture.mjs';
import { createClientFixture } from './client-fixture.mjs';
import { createShutdownFixture } from './shutdown-fixture.mjs';
import { createDiscoveryFixture } from './discovery-fixture.mjs';
import { createMultimodalFixture } from './multimodal-fixture.mjs';
import { createExternalKeyFixture } from './external-key-fixture.mjs';
import { createCompatibleFixture } from './compatible-fixture.mjs';
import { createAzureFixture } from './azure-fixture.mjs';
import { createOllamaFixture } from './ollama-fixture.mjs';
import { createGoogleBoundaryFixture } from './google-boundary-fixture.mjs';
import { createAudioNativeFixture } from './audio-native-fixture.mjs';
import { createBrowserGapFixture } from './browser-gap-fixture.mjs';
import { createCapturedWireReplay } from './captured-wire-replay.mjs';
import { createRealWireSuperserver } from './real-wire-superserver.mjs';

export const conversation = JSON.parse(readFileSync(new URL('./fixtures/conversation.json', import.meta.url), 'utf8'));

// Hand-built protocol fixtures, not a claim that every vendor implements them.
export function createFakeUpstream({ delayMs = 0, chunkDelayMs = 0, status = 200, disconnectAfter = 0, reasoningAnnotation = false, recorded = false, capturedWire = [] } = {}) {
  const metrics = { inference: 0, cancelled: 0, preserved: { human: 0, system: 0 } };
  const replay = recorded ? createRecordedReplay(metrics) : null;
  const routing = createRoutingFixture(metrics);
  const protocol = createProtocolFixture(metrics);
  const media = createMediaFixture(metrics);
  const realtime = createRealtimeFixture(metrics);
  const iam = createIAMFixture(metrics);
  const extension = createExtensionFixture(metrics);
  const quotaExtension = createExtensionFixture(metrics, { root: '/quota-daemon', quota: true });
  const bedrock = createBedrockFixture(metrics);
  const clientFixture = createClientFixture(metrics);
  const shutdownFixture = createShutdownFixture(metrics);
  const discoveryFixture = createDiscoveryFixture(metrics);
  const multimodalFixture = createMultimodalFixture(metrics);
  const externalKeyFixture = createExternalKeyFixture(metrics);
  const compatibleFixture = createCompatibleFixture(metrics);
  const azureFixture = createAzureFixture(metrics);
  const ollamaFixture = createOllamaFixture(metrics);
  const googleBoundaryFixture = createGoogleBoundaryFixture(metrics);
  const audioNativeFixture = createAudioNativeFixture(metrics);
  const browserGapFixture = createBrowserGapFixture(metrics);
  const realWireSuperserver = createRealWireSuperserver(metrics);
  const capturedPeer = capturedWire.length ? createCapturedWireReplay(capturedWire) : null;
  if (capturedPeer) metrics.capturedWire = capturedPeer.metrics;
  const server = http.createServer(async (req, res) => {
    try {
      let path = new URL(req.url, 'http://fixture.invalid').pathname;
      if (path === '/metrics') { res.end(JSON.stringify(metrics)); return; }
      if (await routing(req, res, path)) return;
      if (await protocol(req, res, path)) return;
      if (await media(req, res, path)) return;
      if (await realtime.http(req, res, path)) return;
      if (await iam(req, res, path)) return;
      if (await extension(req, res, path)) return;
      if (await quotaExtension(req, res, path)) return;
      if (await bedrock(req, res, path)) return;
      if (await clientFixture(req, res, path)) return;
      if (await shutdownFixture(req, res, path)) return;
      if (await discoveryFixture(req, res, path)) return;
      if (await multimodalFixture(req, res, path)) return;
      if (await externalKeyFixture(req, res, path)) return;
      if (await compatibleFixture(req, res, path)) return;
      if (await azureFixture(req, res, path)) return;
      if (await ollamaFixture(req, res, path)) return;
      if (await googleBoundaryFixture(req, res, path)) return;
      if (await audioNativeFixture(req, res, path)) return;
      if (await browserGapFixture(req, res, path)) return;
      if (await realWireSuperserver(req, res, path)) return;
      if (capturedPeer && path === '/api/v1/models' && req.method === 'GET') {
        const ids = [...new Set(capturedWire.map(record => JSON.parse(Buffer.from(record.request_body_base64, 'base64').toString('utf8')).model))];
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: ids.map(id => ({ id, supported_endpoints: ['/chat/completions'] })) })); return;
      }
      if (capturedPeer && path === '/v1beta/models' && req.method === 'GET' && capturedWire.every(record => /^\/v1beta\/models\/[^/]+:generateContent$/.test(record.path))) {
        if (!req.headers['x-goog-api-key']) { res.writeHead(401); res.end(); return; }
        const ids = [...new Set(capturedWire.map(record => record.path.match(/^\/v1beta\/models\/([^/]+):generateContent$/)[1]))];
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: ids.map(id => ({ name: 'models/' + id, supportedGenerationMethods: ['generateContent'] })) })); return;
      }
      if (capturedPeer && capturedWire.some(record => record.path === path)) { await capturedPeer.handle(req, res); return; }
      const jsonMatrix = path.startsWith('/json-matrix/');
      if (jsonMatrix) path = path.replace('/json-matrix/', '/matrix/');
      const cancellation = path.match(/^\/cancellation\/(chat|messages|responses)\/([a-z-]+)(\/.*)$/);
      if (cancellation) path = '/' + cancellation[1] + cancellation[3];
      const embedding = path.match(/^\/embedding-matrix\/(primary|secondary|ineligible|unavailable|siliconflow)\/v1\/(models|embeddings)$/);
      if (embedding) {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET' && embedding[2] === 'models') {
          const supported = embedding[1] !== 'ineligible';
          res.end(JSON.stringify({ data: [{ id: supported ? 'fixture-embedding' : 'fixture-chat', supported_endpoints: [supported ? '/embeddings' : '/chat/completions'] }] })); return;
        }
        if (req.method !== 'POST' || embedding[2] !== 'embeddings') { res.writeHead(404); res.end(); return; }
        metrics.inference++;
        const entry = (metrics.embeddings ??= {})[embedding[1]] ??= { attempts: 0, accepted: 0, rejected: 0 };
        entry.attempts++;
        if (req.headers.authorization !== 'Bearer fixture-embedding-token') { entry.rejected++; res.writeHead(401); res.end('{"error":{"message":"Synthetic embedding credential required."}}'); return; }
        let raw = ''; for await (const part of req) raw += part;
        let reply;
        try { reply = embeddingReply(JSON.parse(raw)); }
        catch { entry.rejected++; res.writeHead(422); res.end('{"error":{"message":"Embedding fixture request mismatch."}}'); return; }
        entry.accepted++;
        if (embedding[1] === 'unavailable') { res.writeHead(503); res.end('{"error":{"message":"Embedding fixture unavailable.","type":"fixture_error"}}'); return; }
        res.end(JSON.stringify(reply)); return;
      }
      const matrix = path.match(/^\/matrix\/(chat|messages|responses)\/([a-z-]+)(\/.*)$/);
      if (matrix) path = '/' + matrix[1] + matrix[3];
      if (replay && path.startsWith('/recorded/')) { await replay(req, res, path); return; }
      if (path.startsWith('/preserved/')) {
        const credential = { 'Bearer fixture-preserved-human': 'human', 'Bearer fixture-preserved-system': 'system' }[req.headers.authorization];
        if (!credential) { res.writeHead(401); res.end('{"error":{"message":"Synthetic preserved credential required."}}'); return; }
        if (req.method === 'POST') metrics.preserved[credential]++;
        path = path.slice('/preserved'.length);
      }
      const wire = path.split('/')[1];
      const endpoint = { chat: '/chat/completions', messages: '/messages', responses: '/responses' }[wire];
      if (!endpoint) { res.writeHead(404); res.end(); return; }
      if (path.endsWith('/models')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'fixture', supported_endpoints: [endpoint] }] })); return;
      }
      if (cancellation && path.endsWith('/messages/count_tokens')) {
        let raw = ''; for await (const part of req) raw += part;
        const body = JSON.parse(raw);
        if (body.model !== 'fixture' || req.headers['x-api-key'] !== 'fixture-cancel-token') { res.writeHead(422); res.end('{"error":{"message":"Catalog count fixture mismatch."}}'); return; }
        (metrics.cancellationCounts ??= {})[cancellation[2]] = ((metrics.cancellationCounts ?? {})[cancellation[2]] ?? 0) + 1;
        res.end('{"input_tokens":3}'); return;
      }
      let raw = ''; for await (const part of req) raw += part;
      const input = JSON.parse(raw); metrics.inference++;
      const cancelled = cancellation ? ((metrics.cancellation ??= {})[cancellation[2]] ??= { attempts: 0, cancelled: 0, frames: 0, terminalEmitted: false }) : null;
      if (cancelled) {
        cancelled.attempts++;
        if (!path.endsWith(endpoint) || input.model !== 'fixture' || input.stream !== true || !JSON.stringify(input.messages ?? input.input).includes(conversation.tool.result) || (req.headers.authorization !== 'Bearer fixture-cancel-token' && req.headers['x-api-key'] !== 'fixture-cancel-token')) {
          res.writeHead(422); res.end('{"error":{"message":"Cancellation fixture request mismatch."}}'); return;
        }
      }
      if (matrix) {
        const entry = (metrics.matrix ??= {})[matrix[1] + '/' + matrix[2]] ??= { attempts: 0, accepted: 0, rejected: 0 };
        entry.attempts++;
        try {
          if (entry.accepted >= 2) throw new Error('Matrix conversation already complete.');
          assertMatrixRequest(wire, input, entry.accepted === 1, !jsonMatrix);
          if (jsonMatrix) (metrics.jsonTransport ??= {})[matrix[1] + '/' + matrix[2]] = { stream: input.stream === true, explicitStreamField: Object.hasOwn(input, 'stream') };
          entry.accepted++;
        } catch (error) {
          (metrics.matrixRejections ??= []).push({ key: matrix[1] + '/' + matrix[2], stream: input.stream ?? null, reason: error.message });
          entry.rejected++; res.writeHead(422); res.end('{"error":{"message":"Matrix tool association mismatch."}}'); return;
        }
      }
      let ended = false;
      res.on('close', () => { if (!ended) { metrics.cancelled++; if (cancelled) cancelled.cancelled++; } });
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (res.destroyed) return;
      res.setHeader('Content-Type', 'application/json');
      if (status !== 200) { ended = true; res.writeHead(status); res.end(JSON.stringify({ error: { message: 'Fixture provider refusal.', type: 'fixture_error' } })); return; }
      const final = JSON.stringify(input.messages ?? input.input).includes(conversation.tool.result);
      const { tool, text } = conversation;
      const usage = conversation.usage[final ? 'final' : 'initial'];
      const output = final
        ? [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }]
        : [{ type: 'function_call', id: 'fc_fixture', call_id: tool.id, name: tool.name, arguments: tool.arguments, status: 'completed' }];
      const response = { id: 'resp_fixture', object: 'response', created_at: 1, model: 'fixture', status: 'completed', output, usage };
      const chatMessage = final ? { role: 'assistant', content: text } : { role: 'assistant', content: null, tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }] };
      const content = final ? [{ type: 'text', text }] : [{ type: 'tool_use', id: tool.id, name: tool.name, input: JSON.parse(tool.arguments) }];
      if (!input.stream) {
        ended = true;
        res.end(JSON.stringify(wire === 'responses' ? response : wire === 'chat'
          ? { id: 'chat_fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: chatMessage, finish_reason: final ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens } }
          : { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content, stop_reason: final ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } })); return;
      }
      res.setHeader('Content-Type', 'text/event-stream');
      const frames = [];
      const event = (name, body) => frames.push(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(body)}\n\n`);
      const pieces = [tool.arguments.slice(0, 5), tool.arguments.slice(5)];
      if (wire === 'chat') {
        const chunk = (delta, finish = null, count) => event('', { id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: count ? [] : [{ index: 0, delta, finish_reason: finish }], ...(count ? { usage: count } : {}) });
        chunk({ role: 'assistant', ...(reasoningAnnotation ? { reasoning: 'Fixture annotation.', reasoning_details: [{ type: 'reasoning.text', text: 'Fixture annotation.', format: 'fixture', index: 0 }] } : {}) });
        if (final) chunk({ content: text });
        else {
          chunk({ tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: pieces[0] } }] });
          chunk({ tool_calls: [{ index: 0, function: { arguments: pieces[1] } }] });
        }
        chunk({}, final ? 'stop' : 'tool_calls');
        chunk({}, null, { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens });
        frames.push('data: [DONE]\n\n');
      } else if (wire === 'messages') {
        const emit = (type, fields) => event(type, { type, ...fields });
        emit('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } });
        emit('content_block_start', { index: 0, content_block: final ? { type: 'text', text: '' } : { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
        if (final) emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
        else for (const partial_json of pieces) emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json } });
        emit('content_block_stop', { index: 0 });
        emit('message_delta', { delta: { stop_reason: final ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
        emit('message_stop', {});
      } else {
        let sequence_number = 0;
        const emit = (type, fields) => event(type, { type, sequence_number: sequence_number++, ...fields });
        emit('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } });
        emit('response.output_item.added', { output_index: 0, item: final ? { ...output[0], status: 'in_progress', content: [] } : { ...output[0], status: 'in_progress', arguments: '' } });
        if (final) {
          emit('response.content_part.added', { item_id: 'msg_fixture', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          emit('response.output_text.delta', { item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: text });
          emit('response.output_text.done', { item_id: 'msg_fixture', output_index: 0, content_index: 0, text });
        } else {
          for (const delta of pieces) emit('response.function_call_arguments.delta', { item_id: 'fc_fixture', output_index: 0, delta });
          emit('response.function_call_arguments.done', { item_id: 'fc_fixture', output_index: 0, arguments: tool.arguments });
        }
        emit('response.output_item.done', { output_index: 0, item: output[0] });
        emit('response.completed', { response });
      }
      for (let i = 0; i < frames.length; i++) {
        if (res.destroyed) return;
        res.write(frames[i]);
        if (cancelled) { cancelled.frames++; cancelled.terminalEmitted ||= /data: \[DONE\]|event: message_stop|event: response.completed/.test(frames[i]); }
        if (disconnectAfter && i + 1 >= disconnectAfter) { res.destroy(); return; }
        if (chunkDelayMs || cancelled) await new Promise(resolve => setTimeout(resolve, cancelled ? 25 : chunkDelayMs));
      }
      ended = true; res.end();
    } catch { if (!res.headersSent) res.writeHead(400); res.end('{"error":{"message":"Invalid fixture request."}}'); }
  });
  server.on('upgrade', (req, socket, head) => { void realtime.upgrade(req, socket, head); });
  return { server, metrics };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name, fallback = 0) => Number(process.argv.find(x => x.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
  const port = option('port', 18889);
  const host = process.argv.find(x => x.startsWith('--host='))?.slice('--host='.length) ?? '127.0.0.1';
  const captured = process.argv.find(x => x.startsWith('--captured-wire-file='))?.slice('--captured-wire-file='.length);
  const { server } = createFakeUpstream({ chunkDelayMs: option('chunk-delay-ms'), disconnectAfter: option('disconnect-after'), reasoningAnnotation: process.argv.includes('--reasoning-annotation'), recorded: process.argv.includes('--recorded'), capturedWire: captured ? [JSON.parse(readFileSync(captured, 'utf8'))] : [] });
  server.listen(port, host, () => console.log(JSON.stringify({ url: `http://${host}:${server.address().port}` })));
}
