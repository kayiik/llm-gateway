import assert from "node:assert/strict";
import test from "node:test";
import { fixtureAssistant } from "./fixture-protocol.mjs";

test("client memory fixture answers from actual retained user turns", () => {
  const first = { role: "user", content: "Remember this token for our conversation: alpha-1234. Acknowledge briefly." };
  const second = { role: "user", content: "Also remember this second token: beta-5678. Acknowledge briefly." };
  const recall = { role: "user", content: "Return the token I asked you to remember." };
  assert.equal(fixtureAssistant({ messages: [first, recall] }).content, "alpha-1234");
  assert.throws(() => fixtureAssistant({ messages: [recall] }), /earlier user turn/);
  const both = { role: "user", content: "Return both remembered tokens, separated by one space." };
  assert.equal(fixtureAssistant({ messages: [first, second, both] }).content, "alpha-1234 beta-5678");
  assert.throws(() => fixtureAssistant({ messages: [first, both] }), /both earlier user turns/);
});

test("client Read fixture rejects wrong association and unrelated file results", () => {
  const user = { role: "user", content: "Use Read on /isolated/fixture.txt and return its first line exactly." };
  const request = { messages: [user], tools: [{ type: "function", function: { name: "Read" } }] };
  const assistant = fixtureAssistant(request);
  assert.equal(JSON.parse(assistant.tool_calls[0].function.arguments).file_path, "/isolated/fixture.txt");
  const result = { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "1→llmgw-live-acceptance" };
  assert.equal(fixtureAssistant({ messages: [user, assistant, result] }).content, "llmgw-live-acceptance");
  assert.throws(() => fixtureAssistant({ messages: [user, assistant, { ...result, tool_call_id: "unrelated-call" }] }), /actual Read call/);
  assert.throws(() => fixtureAssistant({ messages: [user, assistant, { ...result, content: "unrelated file" }] }), /actual file result/);
});
