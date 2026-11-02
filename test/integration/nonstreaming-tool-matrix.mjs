import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matrixRequest } from './streaming-tool-matrix.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/conversation.json', import.meta.url), 'utf8'));
const paths = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages' };

export function readNonStreamingReply(wire, text, final) {
  const assistant = JSON.parse(text);
  assert.ok(assistant.error == null, 'successful JSON must not contain an error');
  let tool, content, usage;
  if (wire === 'chat') {
    const choice = assistant.choices?.[0];
    assert.equal(choice?.finish_reason, final ? 'stop' : 'tool_calls');
    const call = choice.message.tool_calls?.[0];
    if (call) tool = { id: call.id, name: call.function.name, arguments: call.function.arguments };
    content = choice.message.content ?? '';
    usage = { input_tokens: assistant.usage?.prompt_tokens, output_tokens: assistant.usage?.completion_tokens };
  } else if (wire === 'messages') {
    assert.equal(assistant.stop_reason, final ? 'end_turn' : 'tool_use');
    const call = assistant.content.find(item => item.type === 'tool_use');
    if (call) tool = { id: call.id, name: call.name, arguments: JSON.stringify(call.input) };
    content = assistant.content.filter(item => item.type === 'text').map(item => item.text).join('');
    usage = assistant.usage;
  } else {
    assert.equal(assistant.status, 'completed');
    const call = assistant.output.find(item => item.type === 'function_call');
    if (call) tool = { id: call.call_id, name: call.name, arguments: call.arguments };
    content = assistant.output.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('');
    usage = assistant.usage;
  }
  const expected = fixture.usage[final ? 'final' : 'initial'];
  assert.equal(usage?.input_tokens, expected.input_tokens);
  assert.equal(usage?.output_tokens, expected.output_tokens);
  if (final) { assert.equal(tool, undefined); assert.equal(content, fixture.text); }
  else {
    assert.equal(content, ''); assert.equal(tool?.id, fixture.tool.id); assert.equal(tool.name, fixture.tool.name);
    assert.deepEqual(JSON.parse(tool.arguments), JSON.parse(fixture.tool.arguments));
  }
  return { assistant, tool, usage };
}

export async function runNonStreamingToolMatrix({ admin, publicCall, metrics, save }) {
  const evidence = { boundary: 'Installed Gateway JSON tool conversations through direct and named routes', pass: false, cases: [] };
  const before = (await metrics()).inference;
  const request = (wire, model, answer) => { const body = matrixRequest(wire, model, answer); body.stream = false; delete body.stream_options; return body; };
  for (const upstream of Object.keys(paths)) for (const ingress of Object.keys(paths)) for (const routed of [false, true]) {
    const name = `json-${ingress}-to-${upstream}-${routed ? 'route' : 'direct'}`;
    const provider = 'matrix-' + name;
    const key = upstream + '/' + name;
    const row = { name, ingress, upstream, routed, pass: false }; evidence.cases.push(row);
    try {
      await admin('providers', { id: provider, registry_id: { chat: 'openrouter', responses: 'openai', messages: 'anthropic' }[upstream], base_url: `http://upstream:18889/json-matrix/${key}`, api_key: 'fixture-matrix-token', force_api_support: upstream === 'responses' });
      await admin(`providers/${provider}/refresh`, {});
      const model = routed ? provider + '-route' : provider + '/fixture';
      if (routed) await admin('endpoints', { name: model, ingress: Object.values(paths), allow_adaptation: true, failover: [{ provider, model: 'fixture' }] });
      const first = await publicCall(name + '-first', paths[ingress], request(ingress, model), undefined, routed ? '' : 'allow');
      if (ingress === 'responses' && upstream === 'messages') {
        assert.equal(first.status, 400, first.text); assert.match(first.text, /request_loss/); assert.match(first.text, /strict/);
        assert.equal((await metrics()).matrix?.[key]?.attempts ?? 0, 0); row.disposition = 'expected-strict-tool-refusal'; row.upstreamCalls = 0;
      } else {
        assert.equal(first.status, 200, first.text); assert.match(first.contentType, /application\/json/);
        const answer = readNonStreamingReply(ingress, first.text, false);
        const second = await publicCall(name + '-second', paths[ingress], request(ingress, model, answer), undefined, routed ? '' : 'allow');
        assert.equal(second.status, 200, second.text);
        const final = readNonStreamingReply(ingress, second.text, true);
        const actual = (await metrics()).matrix[key];
        assert.deepEqual(actual, { attempts: 2, accepted: 2, rejected: 0 });
        const transport = (await metrics()).jsonTransport[key];
        assert.equal(transport.stream, false, 'these compatible JSON paths must not request a stream');
        if (upstream === ingress) assert.equal(transport.explicitStreamField, true, 'native explicit false must remain present');
        row.upstreamTransport = transport;
        row.disposition = 'two-turn-complete'; row.upstreamCalls = 2; row.usage = [answer.usage, final.usage];
      }
      row.pass = true;
    } catch (error) { row.error = error.message; }
    finally { save('nonstreaming-tool-matrix.json', evidence); }
  }
  evidence.upstreamCalls = (await metrics()).inference - before;
  evidence.pass = evidence.cases.length === 18 && evidence.upstreamCalls === 32 && evidence.cases.every(row => row.pass);
  save('nonstreaming-tool-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
