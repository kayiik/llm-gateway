import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, CallError, UnsupportedRequest } from "./index.mjs";
import { StreamProtocolError } from "./stream.mjs";

async function serve(answer) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const body = req.method === "POST" ? JSON.parse(await new Promise((resolve) => {
      let data = "";
      req.on("data", (part) => { data += part; });
      req.on("end", () => resolve(data));
    })) : null;
    calls.push({ path: req.url, body });
    const [status, payload] = answer(req.url, body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("gateway first, then an application-directed cross-dialect cascade", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "llmgw-sdk-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bad = await serve(() => [401, { error: "rejected" }]);
  const good = await serve(() => [200, { type: "message", stop_reason: "end_turn", content: [{ type: "text", text: "hello" }] }]);
  t.after(() => bad.close());
  t.after(() => good.close());
  const snapshot = { version: 1, selectors: { coding: { targets: ["bad/model", "good/model"], allow_adaptation: true } }, targets: {
    "bad/model": { dialect: "chat", model: "model", base_url: bad.url, api_key: "bad-key" },
    "good/model": { dialect: "messages", model: "model", base_url: good.url, api_key: "good-key" },
  } };
  const gateway = await serve((path) => path === "/v1/client-snapshot" ? [200, snapshot] : [200, { choices: [{ message: { content: "online" } }] }]);
  const cachePath = join(dir, "cache.json");
  const options = { url: gateway.url, key: "project-key", cachePath,
    localTargets: () => ["bad/model", "good/model"], shouldTryNext: (error) => error instanceof CallError && error.status === 401 };
  const client = await new Client(options).load();
  await client.refresh();
  await assert.rejects(() => new Client({ ...options, key: "another-project-key" }).load(), /different gateway or key/);
  await assert.rejects(() => new Client({ ...options, url: "http://127.0.0.1:1" }).load(), /different gateway or key/);
  const input = { messages: [{ role: "user", content: "hi" }], max_tokens: 32 };
  const online = await client.callWithInfo("chat", "coding", input);
  assert.equal(online.data.choices[0].message.content, "online");
  assert.equal(online.source, "gateway");
  assert.equal(bad.calls.length, 0);
  await gateway.close();
  const offline = await client.callWithInfo("chat", "coding", input);
  assert.equal(offline.data.choices[0].message.content, "hello");
  assert.equal(offline.source, "direct");
  assert.equal(offline.target, "good/model");
  assert.equal(bad.calls[0].path, "/v1/chat/completions");
  assert.equal(good.calls[0].path, "/v1/messages");
  const restarted = await new Client({ ...options, localTargets: () => ["good/model"] }).load();
  assert.equal((await restarted.call("responses", "coding", { input: "hi" })).output[0].content[0].text, "hello");
  await assert.rejects(() => restarted.call("chat", "coding", { ...input, tools: [{ type: "function" }] }), UnsupportedRequest);
});

test("plain text calls convert in all nine dialect directions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "llmgw-matrix-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const answers = {
    chat: { choices: [{ finish_reason: "stop", message: { content: "hello" } }] },
    responses: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] },
    messages: { id: "msg_fixture", stop_reason: "end_turn", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 5, output_tokens: 2 } },
  };
  const targets = {};
  const servers = [];
  for (const dialect of Object.keys(answers)) {
    const server = await serve(() => [200, answers[dialect]]);
    servers.push(server);
    t.after(() => server.close());
    targets[`${dialect}/native`] = { dialect, model: "native", base_url: server.url, api_key: "fixture-key" };
  }
  let unavailable = false;
  const gateway = await serve((path) => path === "/v1/client-snapshot"
    ? [200, { version: 1, selectors: { coding: { targets: Object.keys(targets), allow_adaptation: true } }, targets }]
    : [unavailable ? 503 : 200, { error: "unavailable" }]);
  t.after(() => gateway.close());
  const selected = { id: "chat/native" };
  const client = await new Client({ url: gateway.url, key: "project-key", cachePath: join(dir, "snapshot.json"),
    localTargets: () => [selected.id], isGatewayUnavailable: (error) => error.status === 503 }).load();
  await client.refresh();
  unavailable = true;
  const requests = {
    chat: { messages: [{ role: "user", content: "hi" }], max_tokens: 32 },
    responses: { input: "hi", max_output_tokens: 32 },
    messages: { messages: [{ role: "user", content: "hi" }], max_tokens: 32 },
  };
  for (const ingress of Object.keys(requests)) for (const dialect of Object.keys(answers)) {
    selected.id = `${dialect}/native`;
    const response = await client.call(ingress, "coding", requests[ingress]);
    const text = ingress === "chat" ? response.choices[0].message.content : ingress === "messages" ? response.content[0].text : response.output[0].content[0].text;
    assert.equal(text, "hello", `${ingress} -> ${dialect}`);
    if (dialect === "messages" && ingress === "chat") {
      assert.equal(response.id, "msg_fixture");
      assert.deepEqual(response.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    }
  }
  assert.equal(servers.reduce((total, server) => total + server.calls.length, 0), 9);
  answers.responses.output[0].content[0].annotations = [{ type: "citation" }];
  selected.id = "responses/native";
  await assert.rejects(() => client.call("chat", "coding", requests.chat), UnsupportedRequest);
  answers.responses.output.push({ type: "function_call", name: "run" });
  selected.id = "responses/native";
  await assert.rejects(() => client.call("chat", "coding", requests.chat), UnsupportedRequest);
  delete answers.chat.choices[0].finish_reason;
  selected.id = "chat/native";
  await assert.rejects(() => client.call("messages", "coding", requests.messages), UnsupportedRequest);
  selected.id = "messages/native";
  await assert.rejects(() => client.call("chat", "coding", {
    messages: [{ role: "user", content: "hi" }, { role: "system", content: "late" }], max_tokens: 32,
  }), UnsupportedRequest);
  await assert.rejects(() => client.call("chat", "coding", {
    messages: [{ role: "assistant", content: "hi", tool_calls: [{ id: "tool" }] }], max_tokens: 32,
  }), UnsupportedRequest);
  client.snapshot.selectors.coding.ingress = ["/v1/messages"];
  await assert.rejects(() => client.call("chat", "coding", requests.chat), UnsupportedRequest);
  delete client.snapshot.selectors.coding.ingress;
  client.snapshot.targets["chat/native"].expires_at = 1;
  selected.id = "chat/native";
  await assert.rejects(() => client.call("chat", "coding", requests.chat), UnsupportedRequest);
});

test("proxy outage requires an explicit decision; gateway 401 never falls back", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "llmgw-proxy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const direct = await serve(() => [200, { choices: [{ message: { content: "local" } }] }]);
  t.after(() => direct.close());
  const snapshot = { version: 1, selectors: { coding: { targets: ["direct/model"] } },
    targets: { "direct/model": { dialect: "chat", model: "model", base_url: direct.url, api_key: "fixture" } } };
  let status = 503;
  const gateway = await serve((path) => path === "/v1/client-snapshot" ? [200, snapshot] : [status, { error: "unavailable" }]);
  t.after(() => gateway.close());
  const options = { url: gateway.url, key: "project-key", cachePath: join(dir, "snapshot.json"), localTargets: () => ["direct/model"] };
  const defaultClient = await new Client(options).load();
  await defaultClient.refresh();
  const body = { messages: [{ role: "user", content: "hi" }] };
  await assert.rejects(() => defaultClient.call("chat", "coding", body), (error) => error instanceof CallError && error.status === 503);
  assert.equal(direct.calls.length, 0);
  const optedIn = await new Client({ ...options, isGatewayUnavailable: (error) => error.status === 503 }).load();
  assert.equal((await optedIn.call("chat", "coding", body)).choices[0].message.content, "local");
  status = 401;
  await assert.rejects(() => optedIn.call("chat", "coding", body), (error) => error instanceof CallError && error.status === 401);
  assert.equal(direct.calls.length, 1);
});

test("stream uses gateway first, then converts a direct text stream without retrying an opened failure", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "llmgw-stream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let localCalls = 0, otherCalls = 0, failAfterDelta = false;
  const local = createServer(async (req, res) => {
    for await (const _ of req) {}
    localCalls++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (kind, value) => res.write(`event: ${kind}\ndata: ${JSON.stringify(value)}\n\n`);
    send("message_start", { type: "message_start", message: { id: "msg_local", role: "assistant", usage: { input_tokens: 5 } } });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } });
    if (failAfterDelta) send("error", { type: "error", error: { type: "api_error" } });
    else {
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
      send("message_stop", { type: "message_stop" });
    }
    res.end();
  });
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => local.close(resolve)));
  const base = `http://127.0.0.1:${local.address().port}`;
  const other = await serve(() => { otherCalls++; return [200, {}]; });
  t.after(() => other.close());
  let refusedCalls = 0;
  const refused = await serve(() => { refusedCalls++; return [401, { error: "unavailable" }]; });
  t.after(() => refused.close());
  const snapshot = { version: 1, selectors: { coding: { allow_adaptation: true,
    ingress: ["/v1/chat/completions"], targets: ["refused/model", "local/model", "other/model"] } }, targets: {
    "refused/model": { dialect: "messages", model: "model", base_url: refused.url, api_key: "refused-key" },
    "local/model": { dialect: "messages", model: "model", base_url: base, api_key: "local-key" },
    "other/model": { dialect: "chat", model: "model", base_url: other.url, api_key: "other-key" },
  } };
  let gatewayDown = false, gatewayStatus = 503;
  const gateway = createServer(async (req, res) => {
    for await (const _ of req) {}
    if (req.url === "/v1/client-snapshot") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(snapshot)); return; }
    if (gatewayDown) { res.writeHead(gatewayStatus); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: {"choices":[{"index":0,"delta":{"content":"online"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const client = await new Client({ url: `http://127.0.0.1:${gateway.address().port}`, key: "project-key",
    cachePath: join(dir, "snapshot.json"), localTargets: () => ["refused/model", "local/model", "other/model"],
    shouldTryNext: () => true, isGatewayUnavailable: (error) => error.status === 503 }).load();
  await client.refresh();
  const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 32 };
  const online = await client.stream("chat", "coding", body);
  assert.equal(online.source, "gateway");
  const native = [];
  for await (const value of online.events) native.push(value);
  assert.equal(native.at(-1).data, "[DONE]");
  gatewayDown = true;
  const offline = await client.stream("chat", "coding", { ...body, stream: true });
  assert.equal(offline.source, "direct");
  assert.equal(offline.target, "local/model");
  assert.equal(refusedCalls, 1, "opening refusal advanced to the next local target");
  const converted = [];
  for await (const value of offline.events) converted.push(value);
  assert.equal(converted.filter(({ data }) => data?.choices?.[0]?.delta?.content).map(({ data }) => data.choices[0].delta.content).join(""), "hello");
  assert.equal(converted.at(-1).data, "[DONE]");
  const cancelled = await client.stream("chat", "coding", body);
  const iterator = cancelled.events[Symbol.asyncIterator]();
  await iterator.next();
  cancelled.cancel();
  await assert.rejects(() => iterator.next(), (error) => error.name === "AbortError" || error instanceof StreamProtocolError);
  failAfterDelta = true;
  const partial = await client.stream("chat", "coding", body);
  let sawText = false;
  await assert.rejects(async () => {
    for await (const value of partial.events) if (value.data?.choices?.[0]?.delta?.content) sawText = true;
  }, StreamProtocolError);
  assert.equal(sawText, true);
  assert.equal(localCalls, 3);
  assert.equal(refusedCalls, 3);
  assert.equal(otherCalls, 0, "a stream that opened was never replayed on the next target");
  gatewayStatus = 401;
  client.isGatewayUnavailable = () => true;
  await assert.rejects(() => client.stream("chat", "coding", body), (error) => error instanceof CallError && error.status === 401);
  assert.equal(refusedCalls, 3, "gateway authentication refusal cannot enter local mode");
});
