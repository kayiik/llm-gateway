import assert from 'node:assert/strict';

const answer = 'fixture-client-ok';

export function createClientFixture(metrics) {
  return async (req, res, path) => {
    const match = path.match(/^\/clients\/(openai|anthropic)\/v1\/(models|chat\/completions|responses|messages(?:\/count_tokens)?)$/);
    if (!match) return false;
    const [, family, operation] = match;
    const state = metrics.clients ??= { catalogs: {}, calls: [], rejected: 0, cancelled: 0 };
    const credential = family === 'openai' ? req.headers.authorization === 'Bearer fixture-client-upstream-key' : req.headers['x-api-key'] === 'fixture-client-upstream-key';
    res.setHeader('Content-Type', 'application/json');
    if (!credential) { state.rejected++; res.writeHead(401); res.end('{"error":{"message":"Controlled client provider credential required."}}'); return true; }
    if (operation === 'models' && req.method === 'GET') {
      state.catalogs[family] = (state.catalogs[family] ?? 0) + 1;
      const observed = new Date();
      res.end(JSON.stringify({ data: family === 'openai' ? [
        { id: 'fixture-client-chat', supported_endpoints: ['/chat/completions'] },
        { id: 'fixture-client-responses', supported_endpoints: ['/responses'], wire_preservation: { responses: 'supported' }, capabilities: {
          schema_version: 1, operations: { chat: 'supported', embeddings: 'unsupported', image: 'unsupported', audio_in: 'unsupported', audio_out: 'unsupported', video: 'unsupported', token_count: 'unsupported' },
          surfaces: { chat_completions: 'unsupported', responses: 'supported', messages: 'unsupported' },
          tools: 'supported', streaming: 'supported', reasoning: 'unknown', structured_output: 'unknown', stateful_responses: 'unknown',
          provenance: { source: 'upstream_reported', confidence: 'high' },
          freshness: { discovered_at: observed.toISOString(), expires_at: new Date(observed.getTime() + 3600000).toISOString() },
        } },
      ] : [{ id: 'fixture-client-messages', supported_endpoints: ['/messages'] }] })); return true;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const input = JSON.parse(raw);
      assert.equal(req.method, 'POST');
      const model = { 'chat/completions': 'fixture-client-chat', responses: 'fixture-client-responses', messages: 'fixture-client-messages', 'messages/count_tokens': 'fixture-client-messages' }[operation];
      assert.equal(input.model, model);
      assert.ok(operation === 'responses' ? input.input : Array.isArray(input.messages) && input.messages.length);
      if (family === 'anthropic') assert.ok(req.headers['anthropic-version'], 'the SDK protocol version must reach native Messages unchanged');
      if (operation === 'messages/count_tokens') { res.end('{"input_tokens":2}'); return true; }
      const results = input.messages?.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []) ?? [];
      if (results.length) { assert.equal(results.length, 1); assert.equal(results[0].tool_use_id, 'tool_client_fixture'); assert.equal(results[0].content, 'result-fixture'); }
      const tool = operation === 'messages' && Array.isArray(input.tools) && input.tools.length > 0 && results.length === 0;
      const payload = operation === 'chat/completions'
        ? { id: 'chat_client_fixture', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }
        : operation === 'messages' ? { id: 'msg_client_fixture', type: 'message', role: 'assistant', model, content: tool ? [{ type: 'tool_use', id: 'tool_client_fixture', name: 'lookup', input: { q: 'fixture' } }] : [{ type: 'text', text: answer }], stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 2 } }
          : { id: 'resp_client_fixture', object: 'response', created_at: 1, model, status: 'completed', output: [{ type: 'message', id: 'msg_client_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }], ...(JSON.stringify(input.input).match(/phase:(final_answer|commentary|future_phase)/)?.[1] ? { phase: JSON.stringify(input.input).match(/phase:(final_answer|commentary|future_phase)/)[1] } : {}) }], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 }, ...(input.metadata?.fixture_instructions ? { instructions: input.metadata.fixture_instructions } : {}) };
      state.calls.push({ family, operation, model, stream: input.stream === true, ...(input.metadata?.fixture_instructions ? { instructions: input.metadata.fixture_instructions } : {}) }); metrics.inference++;
      if (!input.stream) { res.end(JSON.stringify(payload)); return true; }
      res.setHeader('Content-Type', 'text/event-stream');
      if (operation === 'responses') {
        let sequence_number = 0;
        const event = (type, fields) => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence_number++, ...fields })}\n\n`); };
        const item = payload.output[0];
        let complete = false;
        res.on('close', () => { if (!complete) state.cancelled++; });
        event('response.created', { response: { ...payload, status: 'in_progress', output: [], usage: null } });
        if (typeof input.input === 'string' && input.input.includes('cancel after the opening event')) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (res.destroyed) return true;
        }
        event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
        event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: answer });
        event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: answer });
        event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
        event('response.output_item.done', { output_index: 0, item });
        event('response.completed', { response: payload }); complete = true; res.end(); return true;
      }
      if (operation === 'messages') {
        const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        event('message_start', { message: { ...payload, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } });
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
        event('content_block_stop', { index: 0 }); event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }); event('message_stop', {}); res.end(); return true;
      }
      res.end(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return true;
    } catch { state.rejected++; res.writeHead(422); res.end('{"error":{"message":"Controlled client wire mismatch."}}'); return true; }
  };
}
