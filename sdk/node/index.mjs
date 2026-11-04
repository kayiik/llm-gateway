import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { nativeEvents, parseSSE, translatedEvents } from "./stream.mjs";

const paths = { chat: "/v1/chat/completions", responses: "/v1/responses", messages: "/v1/messages" };

export class UnsupportedRequest extends Error {}
export class CallError extends Error {
  constructor(status) { super(`Upstream returned HTTP ${status}`); this.status = status; }
}

function turns(dialect, body) {
  const allowed = {
    chat: ["model", "messages", "max_tokens"],
    responses: ["model", "input", "max_output_tokens"],
    messages: ["model", "messages", "system", "max_tokens"],
  };
  if (!allowed[dialect] || Object.keys(body).some((key) => !allowed[dialect].includes(key)))
    throw new UnsupportedRequest("Only plain text turns and output-token limits can be converted locally");
  let source = dialect === "responses" ? body.input ?? [] : body.messages ?? [];
  if (typeof source === "string") source = [{ role: "user", content: source }];
  if (!Array.isArray(source)) throw new UnsupportedRequest("Text messages must be a list");
  const result = [];
  if (dialect === "messages" && body.system) {
    if (typeof body.system !== "string") throw new UnsupportedRequest("Only text system instructions can be converted");
    result.push({ role: "system", content: body.system });
  }
  for (const item of source) {
    if (!item || Object.keys(item).some((key) => key !== "role" && key !== "content") || !["system", "user", "assistant"].includes(item.role) || typeof item.content !== "string")
      throw new UnsupportedRequest("Only plain text system, user, and assistant turns can be converted");
    result.push({ role: item.role, content: item.content });
  }
  if (!result.length) throw new UnsupportedRequest("At least one text turn is required");
  const limit = dialect === "responses" ? body.max_output_tokens : body.max_tokens;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0))
    throw new UnsupportedRequest("Output-token limit must be a positive integer");
  return [result, limit];
}

function encode(dialect, model, textTurns, limit) {
  if (dialect === "chat") return { model, messages: textTurns, ...(limit ? { max_tokens: limit } : {}) };
  if (dialect === "responses") return { model, input: textTurns, ...(limit ? { max_output_tokens: limit } : {}) };
  if (dialect === "messages") {
    const messages = textTurns.filter((turn) => turn.role !== "system");
    if (!messages.length) throw new UnsupportedRequest("Messages needs a user or assistant turn");
    const systems = textTurns.filter((turn) => turn.role === "system");
    if (systems.length > 1 || (systems.length && textTurns[0].role !== "system"))
      throw new UnsupportedRequest("Only one leading system instruction can be converted to Messages");
    const system = systems[0]?.content;
    return { model, messages, max_tokens: limit ?? 1024, ...(system ? { system } : {}) };
  }
  throw new UnsupportedRequest("Unknown target dialect");
}

function text(dialect, response) {
  let value;
  if (dialect === "chat") {
    if (response.choices?.length !== 1 || response.choices[0].finish_reason !== "stop" || response.choices[0].message?.tool_calls || response.choices[0].message?.refusal)
      throw new UnsupportedRequest("Target response includes unsupported completion semantics");
    value = response.choices?.[0]?.message?.content;
  } else if (dialect === "messages") {
    if (response.stop_reason !== "end_turn" || response.content?.some((part) => part?.type !== "text" || typeof part.text !== "string" ||
      part.citations !== undefined && (!Array.isArray(part.citations) || part.citations.length !== 0)))
      throw new UnsupportedRequest("Target response includes unsupported completion semantics");
    value = response.content?.map((part) => part.text).join("");
  } else {
    if (response.status !== "completed" || response.output?.some((item) => item?.type !== "message" || !Array.isArray(item.content) || item.content.some((part) => part?.type !== "output_text" || typeof part.text !== "string" ||
      part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length !== 0))))
      throw new UnsupportedRequest("Target response includes unsupported completion semantics");
    if (response.output_text !== undefined && response.output?.length && response.output_text !== response.output.flatMap((item) => item.content.map((part) => part.text)).join(""))
      throw new UnsupportedRequest("Target response text fields disagree");
    value = response.output_text ?? response.output?.flatMap((item) => item.content.map((part) => part.text)).join("");
  }
  if (typeof value !== "string") throw new UnsupportedRequest("Target response is not a plain text answer");
  return value;
}

function decode(dialect, model, value, source = {}) {
  const id = typeof source.id === "string" && source.id ? source.id : `local_${randomUUID()}`;
  const created = Number.isInteger(source.created ?? source.created_at) ? source.created ?? source.created_at : Math.floor(Date.now() / 1000);
  const input = source.usage?.input_tokens ?? source.usage?.prompt_tokens;
  const output = source.usage?.output_tokens ?? source.usage?.completion_tokens;
  const observed = Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0 && Number.isSafeInteger(input + output);
  if (dialect === "chat") return { id, created, object: "chat.completion", model,
    choices: [{ index: 0, message: { role: "assistant", content: value }, finish_reason: "stop" }],
    ...(observed ? { usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } } : {}) };
  if (dialect === "messages") return { id, type: "message", role: "assistant", model,
    content: [{ type: "text", text: value }], stop_reason: "end_turn", stop_sequence: null,
    ...(observed ? { usage: { input_tokens: input, output_tokens: output } } : {}) };
  return { id, object: "response", created_at: created, status: "completed", model,
    output: [{ id: `msg_${id}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: value, annotations: [] }] }],
    ...(observed ? { usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } } : {}) };
}

async function request(url, key, body, dialect = "chat") {
  const headers = { Accept: "application/json" };
  if (body && dialect === "messages") Object.assign(headers, { "x-api-key": key, "anthropic-version": "2023-06-01" });
  else headers.Authorization = `Bearer ${key}`;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method: body ? "POST" : "GET", headers, signal: AbortSignal.timeout(30_000), ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) { await response.body?.cancel(); throw new CallError(response.status); }
  let result;
  try { result = await response.json(); }
  catch { throw new UnsupportedRequest("Upstream response is not valid JSON"); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new UnsupportedRequest("Upstream response is not a JSON object");
  return result;
}

async function openStream(url, key, body, dialect, controller) {
  const headers = { Accept: "text/event-stream", "Content-Type": "application/json" };
  if (dialect === "messages") Object.assign(headers, { "x-api-key": key, "anthropic-version": "2023-06-01" });
  else headers.Authorization = `Bearer ${key}`;
  const timer = setTimeout(() => controller.abort(), 30_000);
  timer.unref?.();
  let response;
  try { response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal }); }
  finally { clearTimeout(timer); }
  if (!response.ok) { await response.body?.cancel(); throw new CallError(response.status); }
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
    await response.body?.cancel();
    throw new UnsupportedRequest("Upstream did not open an SSE stream");
  }
  return response.body;
}

export class Client {
  constructor({ url, key, cachePath, localTargets, shouldTryNext = () => false, isGatewayUnavailable = () => false, streamIdleTimeoutMs = 30_000 }) {
    if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) throw new RangeError("streamIdleTimeoutMs must be positive");
    this.url = url.replace(/\/$/, "");
    this.key = key;
    this.cacheOwner = createHash("sha256").update(`${this.url}\0${key}`).digest("hex");
    this.cachePath = cachePath;
    this.localTargets = localTargets;
    this.shouldTryNext = shouldTryNext;
    this.isGatewayUnavailable = isGatewayUnavailable;
    this.streamIdleTimeoutMs = streamIdleTimeoutMs;
    this.snapshot = null;
    this.refreshing = null;
    this.lastAttempt = 0;
  }

  async load() {
    try { this.snapshot = JSON.parse(await readFile(this.cachePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (this.snapshot && this.snapshot.cache_owner !== this.cacheOwner) throw new Error("Saved snapshot belongs to a different gateway or key");
    return this;
  }

  async refresh() {
    const snapshot = await request(`${this.url}/v1/client-snapshot`, this.key);
    if (snapshot.version !== 1 || typeof snapshot.selectors !== "object" || typeof snapshot.targets !== "object")
      throw new Error("Unsupported client snapshot");
    snapshot.fetched_unix = Date.now() / 1000;
    snapshot.cache_owner = this.cacheOwner;
    await mkdir(dirname(this.cachePath), { recursive: true });
    const temp = join(dirname(this.cachePath), `.snapshot-${randomUUID()}`);
    try {
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(snapshot)); } finally { await file.close(); }
      await rename(temp, this.cachePath);
    } finally { await unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    this.snapshot = snapshot;
    return snapshot;
  }

  refreshIfStale() {
    const now = Date.now() / 1000;
    if (this.refreshing || now - this.lastAttempt < 60 || (this.snapshot && now - this.snapshot.fetched_unix <= 3600)) return;
    this.lastAttempt = now;
    this.refreshing = this.refresh().catch(() => {}).finally(() => { this.refreshing = null; });
  }

  async call(dialect, selector, body) {
    return (await this.callWithInfo(dialect, selector, body)).data;
  }

  async callWithInfo(dialect, selector, body) {
    if (!paths[dialect]) throw new Error("Unknown caller dialect");
    if (body.stream) throw new UnsupportedRequest("Use stream() for streaming output");
    this.refreshIfStale();
    const input = { ...body, model: selector };
    try { return { data: await request(this.url + paths[dialect], this.key, input, dialect), source: "gateway" }; }
    catch (error) {
      const code = error.cause?.code;
      const proxyOutage = error instanceof CallError && [502, 503, 504].includes(error.status) && this.isGatewayUnavailable(error);
      if (!proxyOutage && code !== "ECONNREFUSED" && code !== "ENOTFOUND" && code !== "EAI_AGAIN") throw error;
    }
    const entry = this.snapshot?.selectors?.[selector];
    if (!entry) throw new Error("Gateway unavailable and selector has no saved snapshot");
    if (entry.ingress?.length && !entry.ingress.includes(paths[dialect])) throw new UnsupportedRequest("This route does not permit the caller dialect");
    const allowed = new Set(entry.targets);
    let lastError;
    for (const id of this.localTargets(selector, dialect)) {
      if (!allowed.has(id)) throw new Error("Local target is not permitted for this selector");
      const target = this.snapshot.targets[id];
      try {
        if (target.expires_at && Date.now() / 1000 >= target.expires_at) throw new UnsupportedRequest("Local credential has expired");
        if (target.dialect !== dialect && !entry.allow_adaptation) throw new UnsupportedRequest("Conversion is not allowed for this selector");
        const outbound = target.dialect === dialect ? { ...input, model: target.model } : encode(target.dialect, target.model, ...turns(dialect, input));
        const root = target.base_url.replace(/\/$/, "");
        const url = root + (root.endsWith("/v1") ? paths[target.dialect].slice(3) : paths[target.dialect]);
        const response = await request(url, target.api_key, outbound, target.dialect);
        return { data: target.dialect === dialect ? response : decode(dialect, selector, text(target.dialect, response), response), source: "direct", target: id };
      } catch (error) {
        lastError = error;
        if (!this.shouldTryNext(error, id)) throw error;
      }
    }
    throw lastError ?? new Error("No local targets were selected");
  }

  async stream(dialect, selector, body) {
    if (!paths[dialect]) throw new Error("Unknown caller dialect");
    if (body.stream === false) throw new UnsupportedRequest("stream() requires streaming output");
    this.refreshIfStale();
    const input = { ...body, model: selector, stream: true };
    let controller = new AbortController();
    const wrap = (source, target, events) => ({ source, ...(target ? { target } : {}),
      events: (async function* () {
        try {
          for await (const event of events) {
            if (controller.signal.aborted) throw new DOMException("Stream was cancelled", "AbortError");
            yield event;
          }
        } finally { controller.abort(); }
      })(),
      cancel: () => controller.abort() });
    try {
      const upstream = await openStream(this.url + paths[dialect], this.key, input, dialect, controller);
      return wrap("gateway", null, nativeEvents(parseSSE(upstream, this.streamIdleTimeoutMs), dialect));
    } catch (error) {
      const code = error.cause?.code;
      const proxyOutage = error instanceof CallError && [502, 503, 504].includes(error.status) && this.isGatewayUnavailable(error);
      if (!proxyOutage && code !== "ECONNREFUSED" && code !== "ENOTFOUND" && code !== "EAI_AGAIN") throw error;
    }
    const entry = this.snapshot?.selectors?.[selector];
    if (!entry) throw new Error("Gateway unavailable and selector has no saved snapshot");
    if (entry.ingress?.length && !entry.ingress.includes(paths[dialect])) throw new UnsupportedRequest("This route does not permit the caller dialect");
    const allowed = new Set(entry.targets);
    let lastError;
    for (const id of this.localTargets(selector, dialect)) {
      if (!allowed.has(id)) throw new Error("Local target is not permitted for this selector");
      const target = this.snapshot.targets[id];
      controller = new AbortController();
      try {
        if (target.expires_at && Date.now() / 1000 >= target.expires_at) throw new UnsupportedRequest("Local credential has expired");
        if (target.dialect !== dialect && !entry.allow_adaptation) throw new UnsupportedRequest("Conversion is not allowed for this selector");
        const shape = { ...body };
        delete shape.stream;
        const outgoing = target.dialect === dialect
          ? { ...input, model: target.model }
          : { ...encode(target.dialect, target.model, ...turns(dialect, { ...shape, model: selector })), stream: true };
        const root = target.base_url.replace(/\/$/, "");
        const url = root + (root.endsWith("/v1") ? paths[target.dialect].slice(3) : paths[target.dialect]);
        const upstream = await openStream(url, target.api_key, outgoing, target.dialect, controller);
        const records = parseSSE(upstream, this.streamIdleTimeoutMs);
        return wrap("direct", id, target.dialect === dialect ? nativeEvents(records, dialect) : translatedEvents(records, target.dialect, dialect, selector));
      } catch (error) {
        controller.abort();
        lastError = error;
        if (!this.shouldTryNext(error, id)) throw error;
      }
    }
    throw lastError ?? new Error("No local targets were selected");
  }
}
