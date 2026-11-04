import { randomUUID } from "node:crypto";

export class StreamProtocolError extends Error {}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const textPart = (part) => object(part) && part.type === "output_text" && typeof part.text === "string";

async function* timedChunks(body, idleTimeoutMs) {
  const reader = body.getReader();
  try {
    while (true) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new StreamProtocolError("SSE stream idle timeout"));
          void reader.cancel().catch(() => {});
        }, idleTimeoutMs);
      });
      let result;
      try { result = await Promise.race([reader.read(), timeout]); }
      finally { clearTimeout(timer); }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    try { await reader.cancel(); } catch { /* The connection may already have closed. */ }
    reader.releaseLock();
  }
}

// SSE framing is incremental: chunks may divide UTF-8 characters or event lines.
export async function* parseSSE(body, idleTimeoutMs = 30_000) {
  const decoder = new TextDecoder();
  let pending = "", event = "message", data = [], frameSize = 0;
  for await (const bytes of timedChunks(body, idleTimeoutMs)) {
    pending += decoder.decode(bytes, { stream: true });
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      frameSize += line.length + 1;
      if (frameSize > 1_048_576) throw new StreamProtocolError("SSE event exceeds the size limit");
      if (line === "") {
        if (data.length) {
          const raw = data.join("\n");
          let parsed;
          try { parsed = raw === "[DONE]" ? raw : JSON.parse(raw); }
          catch { throw new StreamProtocolError("SSE event is not valid JSON"); }
          if (parsed !== "[DONE]" && !object(parsed)) throw new StreamProtocolError("SSE event is not a JSON object");
          yield { event, data: parsed };
        }
        event = "message";
        data = [];
        frameSize = 0;
      } else if (line.startsWith("event:")) event = line.slice(6).trimStart();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (pending.length + frameSize > 1_048_576) throw new StreamProtocolError("SSE event exceeds the size limit");
  }
  pending += decoder.decode();
  if (pending || data.length) throw new StreamProtocolError("SSE stream ended inside an event");
}

export async function* nativeEvents(records, dialect) {
  let finished = false, chatFinish = false;
  for await (const record of records) {
    const value = record.data;
    if (record.event === "error" || (object(value) && (value.type === "error" || value.error || value.type === "response.failed")))
      throw new StreamProtocolError("Upstream stream reported an error");
    if (dialect === "chat") {
      if (value === "[DONE]") {
        if (!chatFinish) throw new StreamProtocolError("Chat stream ended without a finish reason");
        finished = true;
      } else if (Array.isArray(value.choices) && value.choices.some((choice) => choice.finish_reason != null)) chatFinish = true;
    } else if (dialect === "messages" && value.type === "message_stop") finished = true;
    else if (dialect === "responses" && ["response.completed", "response.incomplete"].includes(value.type)) finished = true;
    yield record;
    if (finished) return;
  }
  throw new StreamProtocolError("Upstream stream ended before its terminal event");
}

// Only the common, stateless text stream is bridged. Unknown content-bearing
// events are rejected instead of silently omitted.
export class TextStreamBridge {
  constructor(source, target, model) {
    this.source = source;
    this.target = target;
    this.model = model;
    this.id = `local_${randomUUID()}`;
    this.created = Math.floor(Date.now() / 1000);
    this.messageID = `msg_${randomUUID()}`;
    this.started = false;
    this.finished = false;
    this.sourceStarted = false;
    this.sourceFinish = false;
    this.text = "";
    this.sequence = 0;
    this.usage = {};
  }

  identity(value) {
    const id = value?.id;
    if (typeof id === "string" && id && !this.started) this.id = id;
    const created = value?.created ?? value?.created_at;
    if (Number.isSafeInteger(created) && !this.started) this.created = created;
    if (typeof value?.model === "string" && value.model && !this.started) this.model = value.model;
  }

  mergeUsage(usage) {
    if (!object(usage)) return;
    const input = usage.input_tokens ?? usage.prompt_tokens;
    const output = usage.output_tokens ?? usage.completion_tokens;
    if (Number.isSafeInteger(input) && input >= 0) this.usage.input = input;
    if (Number.isSafeInteger(output) && output >= 0) this.usage.output = output;
  }

  event(kind, data) {
    if (this.target !== "responses") return { event: kind, data };
    return { event: kind, data: { type: kind, sequence_number: this.sequence++, ...data } };
  }

  envelope(status) {
    const usage = this.usage.input !== undefined && this.usage.output !== undefined && Number.isSafeInteger(this.usage.input + this.usage.output)
      ? { input_tokens: this.usage.input, output_tokens: this.usage.output, total_tokens: this.usage.input + this.usage.output } : null;
    return { id: this.id, object: "response", created_at: this.created, status, model: this.model,
      output: status === "completed" ? [{ id: this.messageID, type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: this.text, annotations: [] }] }] : [],
      store: false, background: false, previous_response_id: null, usage };
  }

  start() {
    if (this.started) return [];
    this.started = true;
    if (this.target === "chat") return [this.event("message", {
      id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })];
    if (this.target === "messages") return [
      this.event("message_start", { type: "message_start", message: { id: this.id, type: "message", role: "assistant", model: this.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: this.usage.input ?? 0, output_tokens: 0 } } }),
      this.event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ];
    return [
      this.event("response.created", { response: this.envelope("in_progress") }),
      this.event("response.output_item.added", { response_id: this.id, output_index: 0,
        item: { id: this.messageID, type: "message", status: "in_progress", role: "assistant", content: [] } }),
      this.event("response.content_part.added", { response_id: this.id, item_id: this.messageID, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] } }),
    ];
  }

  delta(value) {
    if (typeof value !== "string") throw new StreamProtocolError("Text delta is not a string");
    const out = this.start();
    if (!value) return out;
    this.text += value;
    if (this.target === "chat") out.push(this.event("message", { id: this.id, object: "chat.completion.chunk", created: this.created,
      model: this.model, choices: [{ index: 0, delta: { content: value }, finish_reason: null }] }));
    else if (this.target === "messages") out.push(this.event("content_block_delta", {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value },
    }));
    else out.push(this.event("response.output_text.delta", { response_id: this.id, item_id: this.messageID,
      output_index: 0, content_index: 0, delta: value }));
    return out;
  }

  terminal() {
    if (!this.sourceFinish || this.finished) throw new StreamProtocolError("Upstream stream lacks a valid text terminal");
    this.finished = true;
    const out = this.start();
    if (this.target === "chat") return [...out,
      this.event("message", { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      this.event("message", "[DONE]"),
    ];
    if (this.target === "messages") return [...out,
      this.event("content_block_stop", { type: "content_block_stop", index: 0 }),
      this.event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: this.usage.output ?? 0 } }),
      this.event("message_stop", { type: "message_stop" }),
    ];
    const part = { type: "output_text", text: this.text, annotations: [] };
    const item = { id: this.messageID, type: "message", status: "completed", role: "assistant", content: [part] };
    return [...out,
      this.event("response.output_text.done", { response_id: this.id, item_id: this.messageID, output_index: 0, content_index: 0, text: this.text }),
      this.event("response.content_part.done", { response_id: this.id, item_id: this.messageID, output_index: 0, content_index: 0, part }),
      this.event("response.output_item.done", { response_id: this.id, output_index: 0, item }),
      this.event("response.completed", { response: this.envelope("completed") }),
    ];
  }

  feed({ event, data }) {
    if (this.finished) throw new StreamProtocolError("Upstream sent events after the terminal");
    if (event === "error" || (object(data) && (data.error || data.type === "error" || data.type === "response.failed")))
      throw new StreamProtocolError("Upstream stream reported an error");
    if (this.source === "chat") {
      if (data === "[DONE]") { if (!this.sourceFinish) throw new StreamProtocolError("Chat stream lacks finish reason"); return this.terminal(); }
      if (!Array.isArray(data.choices) || data.choices.length > 1) throw new StreamProtocolError("Chat stream has unrepresentable choices");
      this.identity(data);
      this.mergeUsage(data.usage);
      if (!data.choices.length) return [];
      if (this.sourceFinish) throw new StreamProtocolError("Chat stream sent content after its finish reason");
      const choice = data.choices[0], delta = object(choice) ? choice.delta ?? {} : null;
      if (!object(choice) || choice.index !== undefined && choice.index !== 0 || !object(delta) ||
          Object.keys(choice).some((key) => !["index", "delta", "finish_reason"].includes(key)) ||
          Object.keys(delta).some((key) => !["role", "content"].includes(key)) ||
          delta.role && delta.role !== "assistant" ||
          choice.finish_reason != null && choice.finish_reason !== "stop")
        throw new StreamProtocolError("Chat stream has unsupported semantic content");
      const out = this.delta(delta.content ?? "");
      if (choice.finish_reason === "stop") this.sourceFinish = true;
      return out;
    }
    if (!object(data)) throw new StreamProtocolError("Upstream stream event is not an object");
    const kind = data.type ?? event;
    if (this.source === "messages") {
      if (kind === "ping") return [];
      if (kind === "message_start") {
        if (this.sourceStarted || !object(data.message) || (data.message.role && data.message.role !== "assistant") ||
            data.message.content !== undefined && (!Array.isArray(data.message.content) || data.message.content.length !== 0))
          throw new StreamProtocolError("Invalid Messages start event");
        this.sourceStarted = true; this.identity(data.message); this.mergeUsage(data.message.usage);
        return this.start();
      }
      if (!this.sourceStarted) throw new StreamProtocolError("Messages stream lacks message_start");
      if (this.sourceFinish && kind !== "message_stop") throw new StreamProtocolError("Messages stream sent content after its stop reason");
      if (kind === "content_block_start") {
        if (data.index !== 0 || data.content_block?.type !== "text" || Object.keys(data.content_block).some((key) => !["type", "text"].includes(key)))
          throw new StreamProtocolError("Non-text Messages block");
        return this.delta(data.content_block.text ?? "");
      }
      if (kind === "content_block_delta") {
        if (data.index !== 0 || data.delta?.type !== "text_delta" || Object.keys(data.delta).some((key) => !["type", "text"].includes(key)))
          throw new StreamProtocolError("Non-text Messages delta");
        return this.delta(data.delta.text);
      }
      if (kind === "content_block_stop") return data.index === 0 ? [] : (() => { throw new StreamProtocolError("Unknown Messages block"); })();
      if (kind === "message_delta") {
        if (data.delta?.stop_reason !== "end_turn" || data.delta.stop_sequence != null)
          throw new StreamProtocolError("Messages stream did not finish a text turn");
        this.mergeUsage(data.usage); this.sourceFinish = true; return [];
      }
      if (kind === "message_stop") return this.terminal();
      throw new StreamProtocolError("Unsupported Messages event");
    }
    if (kind === "response.created" || kind === "response.in_progress") {
      if (!object(data.response) || data.response.output !== undefined && (!Array.isArray(data.response.output) || data.response.output.length !== 0))
        throw new StreamProtocolError("Responses stream lacks an empty initial response envelope");
      this.sourceStarted = true; this.identity(data.response); this.mergeUsage(data.response.usage);
      return this.start();
    }
    if (!this.sourceStarted) throw new StreamProtocolError("Responses stream lacks response.created");
    if (kind === "response.output_item.added" || kind === "response.output_item.done") {
      if (data.output_index !== 0 || data.item?.type !== "message" || data.item.role !== "assistant")
        throw new StreamProtocolError("Non-text Responses output item");
      const parts = data.item.content ?? [];
      if (!Array.isArray(parts) || parts.some((part) => !textPart(part) ||
          part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length !== 0)))
        throw new StreamProtocolError("Responses output item has unsupported content");
      if (kind.endsWith(".added") && parts.length || kind.endsWith(".done") && parts.length && parts.map((part) => part.text).join("") !== this.text)
        throw new StreamProtocolError("Responses output item changed streamed text");
      return [];
    }
    if (kind === "response.content_part.added" || kind === "response.content_part.done") {
      if (data.output_index !== 0 || data.content_index !== 0 || !textPart(data.part) ||
          data.part.annotations !== undefined && (!Array.isArray(data.part.annotations) || data.part.annotations.length !== 0))
        throw new StreamProtocolError("Non-text Responses content part");
      if (kind.endsWith(".done") && data.part.text !== this.text) throw new StreamProtocolError("Responses content changed after delivery");
      return this.delta(kind.endsWith(".added") ? data.part.text : "");
    }
    if (kind === "response.output_text.delta") {
      if (data.output_index !== 0 || data.content_index !== 0 || data.logprobs?.length) throw new StreamProtocolError("Unexpected Responses text index or logprobs");
      return this.delta(data.delta);
    }
    if (kind === "response.output_text.done") {
      if (this.text === "" && typeof data.text === "string") return this.delta(data.text);
      if (data.text !== this.text) throw new StreamProtocolError("Responses text changed after delivery");
      return [];
    }
    if (kind === "response.completed") {
      if (data.response?.status !== "completed") throw new StreamProtocolError("Responses stream did not complete");
      const items = data.response.output ?? [];
      if (!Array.isArray(items) || items.some((item) => item?.type !== "message" || item.role !== "assistant" ||
          !Array.isArray(item.content) || item.content.some((part) => !textPart(part) ||
            part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length !== 0))))
        throw new StreamProtocolError("Responses terminal has non-text output");
      const finalText = items.flatMap((item) => item.content.map((part) => part.text)).join("");
      if (this.text && finalText !== this.text) throw new StreamProtocolError("Responses terminal changed delivered text");
      this.mergeUsage(data.response.usage);
      const out = this.text ? [] : this.delta(finalText);
      this.sourceFinish = true;
      return [...out, ...this.terminal()];
    }
    throw new StreamProtocolError("Unsupported Responses event");
  }
}

export async function* translatedEvents(records, source, target, model) {
  const bridge = new TextStreamBridge(source, target, model);
  for await (const record of records) {
    for (const output of bridge.feed(record)) yield output;
    if (bridge.finished) return;
  }
  throw new StreamProtocolError("Upstream stream ended before its terminal event");
}
