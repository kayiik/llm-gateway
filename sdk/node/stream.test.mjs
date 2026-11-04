import test from "node:test";
import assert from "node:assert/strict";
import { nativeEvents, parseSSE, StreamProtocolError, translatedEvents } from "./stream.mjs";

function frame(data, event) { return `${event ? `event: ${event}\r\n` : ""}data: ${JSON.stringify(data)}\r\n\r\n`; }
const chat = [
  frame({ id: "chat_src", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
  frame({ choices: [{ index: 0, delta: { content: "hel" }, finish_reason: null }] }),
  frame({ choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] }),
  frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
  "data: [DONE]\r\n\r\n",
];
const messages = [
  frame({ type: "message_start", message: { id: "msg_src", role: "assistant", usage: { input_tokens: 5 } } }, "message_start"),
  frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"),
  frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } }, "content_block_delta"),
  frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }, "content_block_delta"),
  frame({ type: "content_block_stop", index: 0 }, "content_block_stop"),
  frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, "message_delta"),
  frame({ type: "message_stop" }, "message_stop"),
];
const output = { id: "out_src", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] };
const responses = [
  frame({ type: "response.created", response: { id: "resp_src", status: "in_progress", model: "native", output: [] } }, "response.created"),
  frame({ type: "response.output_item.added", output_index: 0, item: { ...output, status: "in_progress", content: [] } }, "response.output_item.added"),
  frame({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }, "response.content_part.added"),
  frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hel" }, "response.output_text.delta"),
  frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "lo" }, "response.output_text.delta"),
  frame({ type: "response.output_text.done", text: "hello" }, "response.output_text.done"),
  frame({ type: "response.content_part.done", output_index: 0, content_index: 0, part: { type: "output_text", text: "hello" } }, "response.content_part.done"),
  frame({ type: "response.output_item.done", output_index: 0, item: { ...output, status: "completed" } }, "response.output_item.done"),
  frame({ type: "response.completed", response: { id: "resp_src", status: "completed", model: "native", output: [output], usage: { input_tokens: 5, output_tokens: 2 } } }, "response.completed"),
];
const fixtures = { chat, messages, responses };

function bytes(records) {
  const data = new TextEncoder().encode(records.join(""));
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < data.length; i += 7) controller.enqueue(data.slice(i, i + 7));
    controller.close();
  } });
}

const types = (events) => events.map((event) => event.data === "[DONE]" ? "[DONE]" : event.data.type ?? event.event);

test("SSE parser handles arbitrary transport splits and nine text-only dialect directions", async () => {
  for (const [source, records] of Object.entries(fixtures)) for (const target of Object.keys(fixtures)) {
    const events = [];
    const sourceEvents = parseSSE(bytes(records));
    for await (const event of source === target ? nativeEvents(sourceEvents, source) : translatedEvents(sourceEvents, source, target, "coding")) events.push(event);
    const names = types(events);
    assert.equal(names.includes(target === "chat" ? "[DONE]" : target === "messages" ? "message_stop" : "response.completed"), true, `${source} -> ${target}`);
    const deltas = target === "chat" ? events.filter(({ data }) => data?.choices?.[0]?.delta?.content).map(({ data }) => data.choices[0].delta.content)
      : target === "messages" ? events.filter(({ data }) => data?.type === "content_block_delta").map(({ data }) => data.delta.text)
      : events.filter(({ data }) => data?.type === "response.output_text.delta").map(({ data }) => data.delta);
    assert.equal(deltas.join(""), "hello", `${source} -> ${target}`);
    if (target === "responses" && source !== target) {
      assert.deepEqual(events.map(({ data }) => data.sequence_number), events.map((_, index) => index), "Responses events have ordered sequence numbers");
      assert.equal(events.at(-1).data.response.output[0].content[0].text, "hello");
      assert.deepEqual(events.at(-1).data.response.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 });
    }
  }
});

test("truncation and errors after a delta never produce a success terminal", async () => {
  for (const [source, records] of Object.entries(fixtures)) {
    const partial = records.slice(0, -1);
    const emitted = [];
    await assert.rejects(async () => {
      for await (const event of translatedEvents(parseSSE(bytes(partial)), source, source === "chat" ? "messages" : "chat", "coding")) emitted.push(event);
    }, StreamProtocolError);
    assert.equal(types(emitted).includes(source === "chat" ? "message_stop" : "[DONE]"), false);
  }
  await assert.rejects(async () => {
    for await (const _ of translatedEvents(parseSSE(bytes([...chat.slice(0, 2), frame({ type: "error", error: { type: "api_error" } }, "error")])), "chat", "messages", "coding")) {}
  }, StreamProtocolError);
});

test("native tool stream passes through; cross-dialect tool content fails closed", async () => {
  const tool = [frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "run", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }), "data: [DONE]\n\n"];
  const native = [];
  for await (const event of nativeEvents(parseSSE(bytes(tool)), "chat")) native.push(event);
  assert.equal(native[0].data.choices[0].delta.tool_calls[0].id, "call_1");
  assert.equal(native.at(-1).data, "[DONE]");
  const converted = [];
  await assert.rejects(async () => {
    for await (const event of translatedEvents(parseSSE(bytes(tool)), "chat", "messages", "coding")) converted.push(event);
  }, StreamProtocolError);
  assert.equal(converted.some(({ event }) => event === "message_stop"), false);
});

test("a source citation cannot be dropped from a converted stream", async () => {
  const annotated = [...responses.slice(0, 6), frame({ type: "response.content_part.done", output_index: 0, content_index: 0,
    part: { type: "output_text", text: "hello", annotations: [{ type: "file_citation" }] } }, "response.content_part.done"), ...responses.slice(7)];
  const emitted = [];
  await assert.rejects(async () => {
    for await (const value of translatedEvents(parseSSE(bytes(annotated)), "responses", "messages", "coding")) emitted.push(value);
  }, StreamProtocolError);
  assert.equal(emitted.some(({ event }) => event === "message_stop"), false);
  const itemCitation = [...responses.slice(0, 7), frame({ type: "response.output_item.done", output_index: 0,
    item: { ...output, content: [{ type: "output_text", text: "hello", annotations: [{ type: "file_citation" }] }] } }, "response.output_item.done"), ...responses.slice(8)];
  await assert.rejects(async () => {
    for await (const _ of translatedEvents(parseSSE(bytes(itemCitation)), "responses", "chat", "coding")) {}
  }, StreamProtocolError);
});

test("a Responses done event can supply text when no earlier delta arrived", async () => {
  const doneOnly = responses.filter((record) => !record.includes("event: response.output_text.delta"));
  const events = [];
  for await (const value of translatedEvents(parseSSE(bytes(doneOnly)), "responses", "chat", "coding")) events.push(value);
  assert.equal(events.filter(({ data }) => data?.choices?.[0]?.delta?.content).map(({ data }) => data.choices[0].delta.content).join(""), "hello");
  assert.equal(events.at(-1).data, "[DONE]");
});

test("a stalled SSE read ends with an idle-timeout error", async () => {
  const stalled = new ReadableStream({ start() {} });
  await assert.rejects(async () => {
    for await (const _ of parseSSE(stalled, 20)) {}
  }, (error) => error instanceof StreamProtocolError && /idle timeout/.test(error.message));
});

test("malformed SSE data fails before a success terminal", async () => {
  await assert.rejects(async () => {
    for await (const _ of parseSSE(bytes(["data: {broken}\n\n"]))) {}
  }, StreamProtocolError);
});

test("SSE keepalive bytes reset the idle timer", async () => {
  let timer, sent = 0;
  const body = new ReadableStream({
    start(controller) {
      timer = setInterval(() => {
        if (++sent < 5) controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        else {
          clearInterval(timer);
          controller.enqueue(new TextEncoder().encode(chat.join("")));
          controller.close();
        }
      }, 25);
    },
    cancel() { clearInterval(timer); },
  });
  const received = [];
  for await (const record of parseSSE(body, 80)) received.push(record);
  assert.equal(received.at(-1).data, "[DONE]");
});

export { fixtures };
