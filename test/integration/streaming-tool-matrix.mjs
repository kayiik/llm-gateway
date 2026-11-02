import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/conversation.json', import.meta.url), 'utf8'));
const paths = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages' };
const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };

export function matrixRequest(wire, model, answer) {
  const user = { role: 'user', content: 'lookup fixture' };
  const body = { model, stream: true };
  const result = fixture.tool.result;
  if (wire === 'responses') {
    body.tools = [{ type: 'function', name: fixture.tool.name, parameters: schema, strict: false }];
    body.input = answer ? [user, ...answer.assistant.output.map(({ id, ...item }) => item), { type: 'function_call_output', call_id: answer.tool.id, output: result }] : user.content;
  } else if (wire === 'messages') {
    body.max_tokens = 32;
    body.tools = [{ name: fixture.tool.name, input_schema: schema }];
    body.messages = answer ? [user, { role: 'assistant', content: answer.assistant.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: answer.tool.id, content: result }] }] : [user];
  } else {
    body.tools = [{ type: 'function', function: { name: fixture.tool.name, parameters: schema } }];
    body.messages = answer ? [user, answer.assistant.choices[0].message, { role: 'tool', tool_call_id: answer.tool.id, content: result }] : [user];
    body.stream_options = { include_usage: true };
  }
  return body;
}

export function assertMatrixRequest(wire, body, final, stream = true) {
  assert.equal(body.model, 'fixture');
  if (stream) assert.equal(body.stream, true);
  else assert.ok(body.stream === false || body.stream === undefined, 'JSON completion permits explicit false or the protocol default');
  assert.ok(body.tools?.some(tool => (tool.function?.name ?? tool.name) === fixture.tool.name), 'tool declaration must reach the selected wire');
  const messages = body.messages ?? [];
  let call, result;
  if (wire === 'responses') {
    const input = Array.isArray(body.input) ? body.input : [];
    call = input.find(item => item.type === 'function_call');
    result = input.find(item => item.type === 'function_call_output');
    if (final) {
      assert.equal(call?.call_id, fixture.tool.id);
      assert.equal(result?.call_id, call.call_id);
      assert.equal(result.output, fixture.tool.result);
      assert.equal(call.name, fixture.tool.name);
      assert.deepEqual(JSON.parse(call.arguments), JSON.parse(fixture.tool.arguments));
    }
  } else if (wire === 'messages') {
    call = messages.filter(item => item.role === 'assistant').flatMap(item => Array.isArray(item.content) ? item.content : []).find(item => item.type === 'tool_use');
    result = messages.filter(item => item.role === 'user').flatMap(item => Array.isArray(item.content) ? item.content : []).find(item => item.type === 'tool_result');
    if (final) {
      assert.equal(call?.id, fixture.tool.id);
      assert.equal(result?.tool_use_id, call.id);
      assert.ok(result.content === fixture.tool.result || (Array.isArray(result.content) && result.content.map(item => item.text ?? '').join('') === fixture.tool.result));
      assert.equal(call.name, fixture.tool.name);
      assert.deepEqual(call.input, JSON.parse(fixture.tool.arguments));
    }
  } else {
    call = messages.find(item => item.role === 'assistant')?.tool_calls?.[0];
    result = messages.find(item => item.role === 'tool');
    if (final) {
      assert.equal(call?.id, fixture.tool.id);
      assert.equal(result?.tool_call_id, call.id);
      assert.equal(result.content, fixture.tool.result);
      assert.equal(call.function.name, fixture.tool.name);
      assert.deepEqual(JSON.parse(call.function.arguments), JSON.parse(fixture.tool.arguments));
    }
  }
  if (!final) { assert.equal(call, undefined); assert.equal(result, undefined); }
}

export function readMatrixReply(wire, text, final) {
  const events = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(value => value && value !== '[DONE]').map(value => JSON.parse(value));
  assert.ok(events.length, 'SSE events required');
  assert.equal(events.find(event => event.type === 'error' || event.error), undefined, 'a successful stream cannot contain an error');
  let assistant, usage, tool, answer;
  if (wire === 'responses') {
    const completed = events.filter(event => event.type === 'response.completed');
    assert.equal(completed.length, 1);
    assistant = completed[0].response;
    assert.equal(assistant.status, 'completed');
    usage = assistant.usage;
    assert.equal(assistant.output.filter(item => item.type === 'function_call').length, final ? 0 : 1);
    const item = assistant.output.find(item => item.type === 'function_call');
    if (item) tool = { id: item.call_id, name: item.name, arguments: item.arguments };
    answer = assistant.output.flatMap(item => item.content ?? []).map(item => item.text ?? '').join('');
  } else if (wire === 'messages') {
    assert.equal(events.filter(event => event.type === 'message_stop').length, 1);
    const start = events.find(event => event.type === 'message_start');
    assert.ok(start?.message, 'message_start required');
    const blocks = [];
    for (const event of events) {
      if (event.type === 'content_block_start') blocks[event.index] = structuredClone(event.content_block);
      if (event.type === 'content_block_delta') {
        const block = blocks[event.index];
        assert.ok(block, 'content delta must follow its block start');
        if (event.delta.type === 'text_delta') block.text = (block.text ?? '') + event.delta.text;
        if (event.delta.type === 'input_json_delta') block.arguments = (block.arguments ?? '') + event.delta.partial_json;
      }
    }
    for (const block of blocks.filter(Boolean)) if (block.type === 'tool_use') { block.input = block.arguments ? JSON.parse(block.arguments) : block.input; delete block.arguments; }
    const terminal = events.findLast(event => event.type === 'message_delta');
    assert.equal(terminal?.delta?.stop_reason, final ? 'end_turn' : 'tool_use');
    assistant = { ...start.message, content: blocks.filter(Boolean) };
    assert.equal(assistant.content.filter(item => item.type === 'tool_use').length, final ? 0 : 1);
    usage = { ...start.message.usage, ...terminal.usage };
    const block = assistant.content.find(item => item.type === 'tool_use');
    if (block) tool = { id: block.id, name: block.name, arguments: JSON.stringify(block.input) };
    answer = assistant.content.filter(item => item.type === 'text').map(item => item.text).join('');
  } else {
    assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
    const message = { role: 'assistant', content: '' };
    const calls = [];
    for (const event of events) for (const choice of event.choices ?? []) {
      if (choice.delta?.content) message.content += choice.delta.content;
      for (const item of choice.delta?.tool_calls ?? []) {
        const call = calls[item.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (item.id) call.id = item.id;
        call.function.name += item.function?.name ?? '';
        call.function.arguments += item.function?.arguments ?? '';
      }
    }
    if (calls.length) message.tool_calls = calls.filter(Boolean);
    assert.equal(message.tool_calls?.length ?? 0, final ? 0 : 1);
    const finish = events.flatMap(event => event.choices ?? []).map(choice => choice.finish_reason).filter(Boolean);
    assert.deepEqual(finish, [final ? 'stop' : 'tool_calls']);
    assistant = { choices: [{ message }] };
    const source = events.findLast(event => event.usage)?.usage;
    assert.ok(source, 'terminal Chat usage required');
    usage = { input_tokens: source.prompt_tokens, output_tokens: source.completion_tokens };
    const call = message.tool_calls?.[0];
    if (call) tool = { id: call.id, name: call.function.name, arguments: call.function.arguments };
    answer = message.content;
  }
  const expected = fixture.usage[final ? 'final' : 'initial'];
  assert.equal(usage?.input_tokens, expected.input_tokens, 'source input usage must survive conversion');
  assert.equal(usage?.output_tokens, expected.output_tokens, 'source output usage must survive conversion');
  if (final) { assert.equal(tool, undefined); assert.equal(answer, fixture.text); }
  else {
    assert.equal(answer, '', 'a tool-only turn must not fabricate answer text');
    assert.equal(tool?.id, fixture.tool.id);
    assert.equal(tool.name, fixture.tool.name);
    assert.deepEqual(JSON.parse(tool.arguments), JSON.parse(fixture.tool.arguments));
  }
  return { assistant, tool, usage };
}

export async function runStreamingToolMatrix({ admin, publicCall, metrics, save }) {
  const evidence = { boundary: 'Actual installed Gateway streaming HTTP, direct and named routes', pass: false, cases: [] };
  const before = (await metrics()).inference;
  for (const upstream of Object.keys(paths)) for (const ingress of Object.keys(paths)) for (const routed of [false, true]) {
    const name = `${ingress}-to-${upstream}-${routed ? 'route' : 'direct'}`;
    const provider = 'matrix-' + name;
    const key = upstream + '/' + name;
    const row = { name, ingress, upstream, routed, pass: false };
    evidence.cases.push(row);
    try {
      await admin('providers', { id: provider, registry_id: { chat: 'openrouter', responses: 'openai', messages: 'anthropic' }[upstream], base_url: `http://upstream:18889/matrix/${key}`, api_key: 'fixture-matrix-token', force_api_support: upstream === 'responses' });
      await admin(`providers/${provider}/refresh`, {});
      const model = routed ? provider + '-route' : provider + '/fixture';
      if (routed) await admin('endpoints', { name: model, ingress: Object.values(paths), allow_adaptation: true, failover: [{ provider, model: 'fixture' }] });
      const first = await publicCall('matrix-' + name + '-first', paths[ingress], matrixRequest(ingress, model), undefined, routed ? '' : 'allow');
      if (ingress === 'responses' && upstream === 'messages') {
        assert.equal(first.status, 400, first.text);
        assert.match(first.text, /request_loss/); assert.match(first.text, /strict/);
        assert.equal((await metrics()).matrix?.[key]?.attempts ?? 0, 0, 'strict conversion refusal must precede dispatch');
        row.disposition = 'expected-strict-tool-refusal'; row.upstreamCalls = 0;
      } else {
        assert.equal(first.status, 200, first.text); assert.match(first.contentType, /text\/event-stream/);
        const answer = readMatrixReply(ingress, first.text, false);
        const second = await publicCall('matrix-' + name + '-second', paths[ingress], matrixRequest(ingress, model, answer), undefined, routed ? '' : 'allow');
        assert.equal(second.status, 200, second.text); assert.match(second.contentType, /text\/event-stream/);
        const final = readMatrixReply(ingress, second.text, true);
        const actual = (await metrics()).matrix?.[key];
        assert.equal(actual?.attempts, 2, 'exactly two dispatches, with no retry');
        assert.equal(actual?.accepted, 2, 'both actual encoded requests must satisfy tool association');
        assert.equal(actual?.rejected, 0);
        row.disposition = 'two-turn-complete'; row.upstreamCalls = actual.accepted;
        row.usage = [answer.usage, final.usage];
      }
      row.pass = true;
    } catch (error) { row.error = error.message; throw new Error(name + ': ' + error.message, { cause: error }); }
    finally { save('streaming-tool-matrix.json', evidence); }
  }
  assert.equal(evidence.cases.length, 18);
  const after = await metrics();
  assert.equal(after.inference - before, 32, 'sixteen supported conversations need exactly two dispatches each; strict refusals dispatch none');
  evidence.upstreamCalls = after.inference - before;
  evidence.pass = true;
  save('streaming-tool-matrix.json', evidence);
}
