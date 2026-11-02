import assert from 'node:assert/strict';
import test from 'node:test';
import { assessGatewayAnswer } from './capture-assessment.mjs';

test('a completed HTTP 200 stream with only reasoning and finish length is not a successful answer', () => {
  const raw = Buffer.from('data: {"choices":[{"delta":{"reasoning":"thinking"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
  const result = assessGatewayAnswer({}, 200, 'text/event-stream', raw);
  assert.equal(result.terminal, 'done'); assert.equal(result.textCharacters, 0);
  assert.equal(result.successfulAnswer, false);
});

test('a complete text stream is usable and a failed terminal or missing output is not', () => {
  const passed = Buffer.from('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}\n\ndata: [DONE]\n\n');
  assert.equal(assessGatewayAnswer({}, 200, 'text/event-stream', passed).successfulAnswer, true);
  const failed = Buffer.from('event: response.failed\ndata: {"response":{"status":"failed"}}\n\ndata: [DONE]\n\n');
  assert.equal(assessGatewayAnswer({}, 200, 'text/event-stream', failed).successfulAnswer, false);
  assert.equal(assessGatewayAnswer({}, 200, 'application/json', Buffer.from('{"choices":[{"finish_reason":"length","message":{"content":null}}]}')).successfulAnswer, false);
});

test('a completed Responses message with output text counts, but reasoning and incomplete output do not', () => {
  const response = { object: 'response', status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'CAPTURE_OK' }] }] };
  const assess = value => assessGatewayAnswer({}, 200, 'application/json', Buffer.from(JSON.stringify(value)));
  assert.equal(assess(response).textCharacters, 10);
  assert.equal(assess(response).successfulAnswer, true);
  assert.equal(assess({ ...response, status: 'incomplete' }).successfulAnswer, false);
  assert.equal(assess({ ...response, output: [{ type: 'reasoning', summary: [{ text: 'thinking' }] }] }).successfulAnswer, false);
});
