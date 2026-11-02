import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const conversation = JSON.parse(readFileSync(new URL('./fixtures/conversation.json', import.meta.url), 'utf8'));
const credentials = new Map([
  ['Bearer fixture-iam-system', 'system'], ['Bearer fixture-iam-a-one', 'a-one'],
  ['Bearer fixture-iam-system-rotated', 'system-rotated'],
  ['Bearer fixture-iam-a-two', 'a-two'], ['Bearer fixture-iam-b', 'b'],
  ['Bearer fixture-iam-a-two-rotated', 'a-two-rotated'],
]);

export function createIAMFixture(metrics) {
  return async (req, res, path) => {
    const match = path.match(/^\/iam\/(chat|alternate|tools)\/v1\/(models|chat\/completions)$/);
    if (!match) return false;
    const state = metrics.iam ??= { calls: [], rejected: 0 }; res.setHeader('Content-Type', 'application/json');
    if (match[2] === 'models') {
      const credential = credentials.get(req.headers.authorization);
      const privateModels = credential === 'a-one' ? ['fixture-owner-a'] : credential === 'b' ? ['fixture-owner-b'] : [];
      res.end(JSON.stringify({ data: ['fixture', 'blocked', ...privateModels].map(id => ({ id, supported_endpoints: ['/chat/completions'], supported_parameters: ['tools', 'tool_choice', 'temperature', 'max_tokens'] })) })); return true;
    }
    metrics.inference++;
    let raw = ''; for await (const part of req) raw += part;
    let body, credential;
    try {
      body = JSON.parse(raw); credential = credentials.get(req.headers.authorization); assert.ok(credential);
      assert.ok(['fixture', 'blocked'].includes(body.model)); assert.ok(Array.isArray(body.messages));
      state.calls.push({ kind: match[1], credential, model: body.model, stream: body.stream === true });
    } catch { state.rejected++; res.writeHead(422); res.end('{"error":{"message":"Identity fixture request mismatch."}}'); return true; }
    if (body.model === 'blocked') { res.writeHead(402); res.end('{"error":{"code":"insufficient_quota","message":"Controlled identity-route credit refusal."}}'); return true; }
    const final = body.messages.some(message => message.role === 'tool');
    let message = { role: 'assistant', content: 'credential:' + credential }, finish = 'stop';
    if (match[1] === 'tools') {
      if (final) {
        const call = body.messages.find(item => item.role === 'assistant')?.tool_calls?.[0];
        const result = body.messages.find(item => item.role === 'tool');
        const assistantIndex = body.messages.findIndex(item => item.role === 'assistant' && item.tool_calls?.some(tool => tool.id === conversation.tool.id));
        const resultIndex = body.messages.findIndex(item => item.role === 'tool' && item.tool_call_id === conversation.tool.id);
        if (call?.id !== conversation.tool.id || result?.tool_call_id !== call.id || result.content !== conversation.tool.result || resultIndex !== assistantIndex + 1) { state.rejected++; res.writeHead(422); res.end('{"error":{"message":"Owner tool result association or order mismatch."}}'); return true; }
        message = { role: 'assistant', content: conversation.text };
      } else {
        assert.ok(body.tools?.some(tool => tool.function?.name === conversation.tool.name)); finish = 'tool_calls';
        message = { role: 'assistant', content: null, tool_calls: [{ id: conversation.tool.id, type: 'function', function: { name: conversation.tool.name, arguments: conversation.tool.arguments } }] };
      }
    }
    const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    if (!body.stream) { res.end(JSON.stringify({ id: 'identity-fixture', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message, finish_reason: finish }], usage })); return true; }
    res.setHeader('Content-Type', 'text/event-stream');
    const chunk = (delta, reason = null) => `data: ${JSON.stringify({ id: 'identity-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
    const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : message;
    res.end(chunk(delta) + chunk({}, finish) + `data: ${JSON.stringify({ id: 'identity-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [], usage })}\n\ndata: [DONE]\n\n`); return true;
  };
}
