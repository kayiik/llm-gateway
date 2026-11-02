import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { modeFor, modesFor, playgroundFailure, playgroundUserTurn, requestHistory } from "./src/pages/Playground.tsx";
      export { APIError, requestJSON } from "./src/lib/api.ts";
    `,
    resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    sourcefile: "playground-test-entry.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  jsxImportSource: "preact",
});
const subject = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

test("playground surfaces only affirmatively supported controls", () => {
  assert.equal(subject.modeFor(undefined), "unknown");
  assert.equal(subject.modeFor({ capabilities: [] }), "unknown");
  assert.equal(subject.modeFor({ capabilities: ["image"] }), "image");
  assert.equal(subject.modeFor({ capabilities: ["tts"] }), "tts");
  assert.equal(subject.modeFor({ capabilities: ["chat", "image"] }), "image");
  assert.deepEqual(subject.modesFor({ capabilities: ["chat", "image"] }), ["image", "chat"]);
  assert.equal(subject.modeFor({ capabilities: ["embedding"] }), "embedding");
});

test("playground failure keeps safe status, code, retry, and action", () => {
  const failure = subject.playgroundFailure(new subject.APIError(
    429,
    "Upstream provider request failed.",
    {},
    "provider_invocation_failed",
    "17",
    true,
    "Wait for the provider window.",
  ));
  assert.deepEqual(failure, {
    message: "Upstream provider request failed.",
    status: 429,
    code: "provider_invocation_failed",
    retry: "After 17",
    action: "Wait for the provider window.",
  });
});

test("tool followup closes the actual assistant call before a note and remains in later history", () => {
  for (const surface of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
    const call = surface === "/v1/responses" ? { type: "function_call", id: "item-actual", call_id: "call-actual", name: "lookup", arguments: "{}" }
      : surface === "/v1/messages" ? { type: "tool_use", id: "call-actual", name: "lookup", input: {} }
      : { id: "call-actual", type: "function", function: { name: "lookup", arguments: "{}" } };
    const wire = surface === "/v1/chat/completions" ? [{ role: "assistant", content: null, tool_calls: [call] }] : [call];
    const before = [{ role: "user", content: "lookup" }, { role: "assistant", content: "", toolCalls: [call], wire }];
    const frozen = structuredClone(before);
    const turn = subject.playgroundUserTurn(surface, before, "Use this result.", { id: "call-actual", output: "actual-result" });
    const history = subject.requestHistory(surface, [...before, turn]);
    if (surface === "/v1/messages") {
      assert.equal(history[2].role, "user");
      assert.deepEqual(history[2].content, [{ type: "tool_result", tool_use_id: "call-actual", content: "actual-result" }, { type: "text", text: "Use this result." }]);
    } else {
      assert.deepEqual(history[2], surface === "/v1/responses" ? { type: "function_call_output", call_id: "call-actual", output: "actual-result" } : { role: "tool", tool_call_id: "call-actual", content: "actual-result" });
      assert.deepEqual(history[3], { role: "user", content: "Use this result." });
    }
    const later = subject.requestHistory(surface, [...before, turn, { role: "assistant", content: "done" }, { role: "user", content: "another turn" }]);
    assert.deepEqual(later.slice(0, history.length), history);
    assert.deepEqual(before, frozen, "building a followup must not mutate captured provider wire");
  }
});

test("an unrelated or already-completed tool call cannot enter followup history", () => {
  const turns = [{ role: "assistant", content: "", toolCalls: [{ id: "actual-call" }] }];
  assert.throws(() => subject.playgroundUserTurn("/v1/chat/completions", turns, "note", { id: "foreign-call", output: "unrelated" }), /pending call/);
  assert.throws(() => subject.playgroundUserTurn("/v1/chat/completions", [...turns, { role: "assistant", content: "completed" }], "note", { id: "actual-call", output: "late" }), /pending call/);
});

test("API client preserves the server error envelope and Retry-After", async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { location: { href: "https://gateway.example/admin", origin: "https://gateway.example", assign() {} } };
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: "Safe provider detail.",
      code: "provider_busy",
      retryable: true,
      action: "Retry against this provider later.",
    },
  }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "9" } });
  try {
    await assert.rejects(
      subject.requestJSON("portal", "/playground"),
      (error) => error instanceof subject.APIError &&
        error.status === 503 &&
        error.message === "Safe provider detail." &&
        error.code === "provider_busy" &&
        error.retryAfter === "9" &&
        error.retryable === true &&
        error.action === "Retry against this provider later.",
    );
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
