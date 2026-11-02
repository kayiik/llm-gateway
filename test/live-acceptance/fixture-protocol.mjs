import assert from "node:assert/strict";

const contentText = value => typeof value === "string" ? value : (Array.isArray(value) ? value.map(part => part.text || "").join("\n") : "");

export function fixtureAssistant(body) {
  const messages = body.messages || [];
  const users = messages.filter(message => message.role === "user").map(message => contentText(message.content));
  const latest = users.at(-1) || "";
  const last = messages.at(-1);
  const read = latest.match(/Use Read on (.+?) and return its first line exactly\./);
  if (last?.role === "tool") {
    const call = messages.filter(message => message.role === "assistant").flatMap(message => message.tool_calls || []).find(item => item.id === last.tool_call_id);
    assert.ok(read && call?.function?.name === "Read", "the result must belong to the actual Read call");
    assert.equal(call.id, "call_acceptance_read");
    assert.equal(JSON.parse(call.function.arguments).file_path, read[1]);
    const result = contentText(last.content);
    assert.ok(result.includes("llmgw-live-acceptance"), "the actual file result must return through the client");
    return { role: "assistant", content: "llmgw-live-acceptance" };
  }
  if (read) {
    assert.ok(body.tools?.some(tool => tool.function?.name === "Read"), "the client must declare Read");
    return { role: "assistant", content: null, tool_calls: [{ id: "call_acceptance_read", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: read[1] }) } }] };
  }
  const tokens = [...new Set(Array.from(users.join("\n").matchAll(/(?:Remember this token for our conversation:|Also remember this second token:)\s*([a-z]+-[a-z0-9]+)/g), match => match[1]))];
  if (latest.includes("Return both remembered tokens")) {
    assert.equal(tokens.length, 2, "both earlier user turns must reach the provider");
    return { role: "assistant", content: tokens.join(" ") };
  }
  if (latest.includes("Return the token I asked you to remember")) {
    assert.ok(tokens.length, "the earlier user turn must reach the provider");
    return { role: "assistant", content: tokens[0] };
  }
  return { role: "assistant", content: "ok" };
}
