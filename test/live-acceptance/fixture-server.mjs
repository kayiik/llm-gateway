import { createServer } from "node:http";
import { fixtureAssistant } from "./fixture-protocol.mjs";

const status = Number(process.env.STATUS || 200);
const models = String(process.env.MODELS || "model").split(",").map((value) => value.trim()).filter(Boolean);

createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url?.includes("/models")) {
    response.end(JSON.stringify({ data: models.map((id) => ({ id, supported_endpoints: ["/v1/chat/completions"] })) }));
    return;
  }
  if (status !== 200) {
    response.writeHead(status);
    response.end(JSON.stringify({ error: { message: `controlled ${status}` } }));
    return;
  }
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    let parsed, message;
    try {
      parsed = JSON.parse(body);
      message = fixtureAssistant(parsed);
    } catch {
      response.writeHead(422);
      response.end(JSON.stringify({ error: { message: "Controlled conversation request mismatch." } }));
      return;
    }
    const model = parsed.model || models[0];
    const finish = message.tool_calls ? "tool_calls" : "stop";
    const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
    if (parsed.stream === true) {
      // A request that streams is answered as an OpenAI-compatible stream.
      const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "chatcmpl-live", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.setHeader("Content-Type", "text/event-stream");
      const delta = message.tool_calls ? { role: "assistant", tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : message;
      response.end(chunk(delta, null) + chunk({}, finish) + `data: ${JSON.stringify({ id: "chatcmpl-live", model, choices: [], usage })}\n\n` + "data: [DONE]\n\n");
      return;
    }
    response.end(JSON.stringify({ id: "chatcmpl-live", model, choices: [{ index: 0, message, finish_reason: finish }], usage }));
  });
}).listen(8080, "0.0.0.0");
