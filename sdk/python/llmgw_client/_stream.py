"""Incremental SSE framing and bounded text-only dialect stream conversion."""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass


class StreamProtocolError(Exception):
    pass


@dataclass(frozen=True)
class StreamEvent:
    event: str
    data: dict | str


def _object(value):
    return isinstance(value, dict)


def _empty_or_missing(value):
    return value is None or isinstance(value, list) and not value


def _text_part(value):
    return (_object(value) and value.get("type") == "output_text" and isinstance(value.get("text"), str)
            and _empty_or_missing(value.get("annotations")))


def parse_sse(response):
    event, data, length = "message", [], 0
    while True:
        try:
            raw_line = response.readline()
        except TimeoutError as cause:
            raise StreamProtocolError("SSE stream idle timeout") from cause
        if not raw_line:
            break
        try:
            line = raw_line.decode("utf-8").rstrip("\n").rstrip("\r")
        except UnicodeError as cause:
            raise StreamProtocolError("SSE event is not UTF-8") from cause
        length += len(raw_line)
        if length > 1_048_576:
            raise StreamProtocolError("SSE event exceeds the size limit")
        if line == "":
            if data:
                raw = "\n".join(data)
                try:
                    value = raw if raw == "[DONE]" else json.loads(raw)
                except ValueError as cause:
                    raise StreamProtocolError("SSE event is not valid JSON") from cause
                if value != "[DONE]" and not _object(value):
                    raise StreamProtocolError("SSE event is not a JSON object")
                yield StreamEvent(event, value)
            event, data, length = "message", [], 0
        elif line.startswith("event:"):
            event = line[6:].lstrip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    if data:
        raise StreamProtocolError("SSE stream ended inside an event")


def native_events(records, dialect):
    chat_finish = False
    for record in records:
        value = record.data
        if record.event == "error" or (_object(value) and (value.get("type") in ("error", "response.failed") or value.get("error"))):
            raise StreamProtocolError("Upstream stream reported an error")
        if dialect == "chat":
            if value == "[DONE]":
                if not chat_finish:
                    raise StreamProtocolError("Chat stream ended without a finish reason")
                yield record
                return
            if isinstance(value.get("choices"), list) and any(choice.get("finish_reason") is not None for choice in value["choices"]):
                chat_finish = True
        elif dialect == "messages" and value.get("type") == "message_stop":
            yield record
            return
        elif dialect == "responses" and value.get("type") in ("response.completed", "response.incomplete"):
            yield record
            return
        yield record
    raise StreamProtocolError("Upstream stream ended before its terminal event")


class TextStreamBridge:
    def __init__(self, source: str, target: str, model: str):
        self.source, self.target, self.model = source, target, model
        self.id = "local_" + uuid.uuid4().hex
        self.message_id = "msg_" + uuid.uuid4().hex
        self.created = int(time.time())
        self.started = self.finished = self.source_started = self.source_finish = False
        self.text = ""
        self.sequence = 0
        self.usage = {}

    def identity(self, value):
        if self.started or not _object(value):
            return
        if isinstance(value.get("id"), str) and value["id"]:
            self.id = value["id"]
        if type(value.get("created", value.get("created_at"))) is int:
            self.created = value.get("created", value.get("created_at"))
        if isinstance(value.get("model"), str) and value["model"]:
            self.model = value["model"]

    def merge_usage(self, value):
        if not _object(value):
            return
        input_tokens = value.get("input_tokens", value.get("prompt_tokens"))
        output_tokens = value.get("output_tokens", value.get("completion_tokens"))
        if type(input_tokens) is int and input_tokens >= 0:
            self.usage["input"] = input_tokens
        if type(output_tokens) is int and output_tokens >= 0:
            self.usage["output"] = output_tokens

    def event(self, kind, data):
        if self.target == "responses":
            data = {"type": kind, "sequence_number": self.sequence, **data}
            self.sequence += 1
        return StreamEvent(kind, data)

    def envelope(self, status):
        usage = None
        if "input" in self.usage and "output" in self.usage:
            usage = {"input_tokens": self.usage["input"], "output_tokens": self.usage["output"], "total_tokens": self.usage["input"] + self.usage["output"]}
        output = [] if status != "completed" else [{"id": self.message_id, "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": self.text, "annotations": []}]}]
        return {"id": self.id, "object": "response", "created_at": self.created, "status": status, "model": self.model, "output": output,
                "store": False, "background": False, "previous_response_id": None, "usage": usage}

    def start(self):
        if self.started:
            return []
        self.started = True
        if self.target == "chat":
            return [self.event("message", {"id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model,
                                           "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})]
        if self.target == "messages":
            return [self.event("message_start", {"type": "message_start", "message": {"id": self.id, "type": "message", "role": "assistant", "model": self.model,
                "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": self.usage.get("input", 0), "output_tokens": 0}}}),
                self.event("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})]
        return [self.event("response.created", {"response": self.envelope("in_progress")}),
                self.event("response.output_item.added", {"response_id": self.id, "output_index": 0,
                    "item": {"id": self.message_id, "type": "message", "status": "in_progress", "role": "assistant", "content": []}}),
                self.event("response.content_part.added", {"response_id": self.id, "item_id": self.message_id, "output_index": 0, "content_index": 0,
                    "part": {"type": "output_text", "text": "", "annotations": []}})]

    def delta(self, value):
        if not isinstance(value, str):
            raise StreamProtocolError("Text delta is not a string")
        out = self.start()
        if not value:
            return out
        self.text += value
        if self.target == "chat":
            out.append(self.event("message", {"id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model,
                                               "choices": [{"index": 0, "delta": {"content": value}, "finish_reason": None}]}))
        elif self.target == "messages":
            out.append(self.event("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": value}}))
        else:
            out.append(self.event("response.output_text.delta", {"response_id": self.id, "item_id": self.message_id,
                "output_index": 0, "content_index": 0, "delta": value}))
        return out

    def terminal(self):
        if not self.source_finish or self.finished:
            raise StreamProtocolError("Upstream stream lacks a valid text terminal")
        self.finished = True
        out = self.start()
        if self.target == "chat":
            return out + [self.event("message", {"id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model,
                                                 "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}), self.event("message", "[DONE]")]
        if self.target == "messages":
            return out + [self.event("content_block_stop", {"type": "content_block_stop", "index": 0}),
                self.event("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": self.usage.get("output", 0)}}),
                self.event("message_stop", {"type": "message_stop"})]
        part = {"type": "output_text", "text": self.text, "annotations": []}
        item = {"id": self.message_id, "type": "message", "status": "completed", "role": "assistant", "content": [part]}
        return out + [self.event("response.output_text.done", {"response_id": self.id, "item_id": self.message_id, "output_index": 0, "content_index": 0, "text": self.text}),
            self.event("response.content_part.done", {"response_id": self.id, "item_id": self.message_id, "output_index": 0, "content_index": 0, "part": part}),
            self.event("response.output_item.done", {"response_id": self.id, "output_index": 0, "item": item}),
            self.event("response.completed", {"response": self.envelope("completed")})]

    def feed(self, record):
        event, data = record.event, record.data
        if self.finished:
            raise StreamProtocolError("Upstream sent events after the terminal")
        if event == "error" or (_object(data) and (data.get("error") or data.get("type") in ("error", "response.failed"))):
            raise StreamProtocolError("Upstream stream reported an error")
        if self.source == "chat":
            if data == "[DONE]":
                if not self.source_finish:
                    raise StreamProtocolError("Chat stream lacks finish reason")
                return self.terminal()
            choices = data.get("choices")
            if not isinstance(choices, list) or len(choices) > 1:
                raise StreamProtocolError("Chat stream has unrepresentable choices")
            self.identity(data)
            self.merge_usage(data.get("usage"))
            if not choices:
                return []
            if self.source_finish:
                raise StreamProtocolError("Chat stream sent content after its finish reason")
            choice = choices[0]
            if not _object(choice):
                raise StreamProtocolError("Chat stream has unsupported semantic content")
            delta = choice.get("delta") or {}
            if (choice.get("index", 0) != 0 or not _object(delta) or set(delta) - {"role", "content"} or
                set(choice) - {"index", "delta", "finish_reason"} or
                delta.get("role") not in (None, "assistant") or choice.get("finish_reason") not in (None, "stop")):
                raise StreamProtocolError("Chat stream has unsupported semantic content")
            out = self.delta(delta.get("content", ""))
            if choice.get("finish_reason") == "stop":
                self.source_finish = True
            return out
        if not _object(data):
            raise StreamProtocolError("Upstream stream event is not an object")
        kind = data.get("type", event)
        if self.source == "messages":
            if kind == "ping":
                return []
            if kind == "message_start":
                if self.source_started or not _object(data.get("message")) or data["message"].get("role") not in (None, "assistant") or not _empty_or_missing(data["message"].get("content")):
                    raise StreamProtocolError("Invalid Messages start event")
                self.source_started = True
                self.identity(data["message"])
                self.merge_usage(data["message"].get("usage"))
                return self.start()
            if not self.source_started:
                raise StreamProtocolError("Messages stream lacks message_start")
            if self.source_finish and kind != "message_stop":
                raise StreamProtocolError("Messages stream sent content after its stop reason")
            if kind == "content_block_start":
                block = data.get("content_block")
                if data.get("index") != 0 or not _object(block) or block.get("type") != "text" or set(block) - {"type", "text"}:
                    raise StreamProtocolError("Non-text Messages block")
                return self.delta(block.get("text", ""))
            if kind == "content_block_delta":
                delta = data.get("delta")
                if data.get("index") != 0 or not _object(delta) or delta.get("type") != "text_delta" or set(delta) - {"type", "text"}:
                    raise StreamProtocolError("Non-text Messages delta")
                return self.delta(delta.get("text"))
            if kind == "content_block_stop":
                if data.get("index") != 0:
                    raise StreamProtocolError("Unknown Messages block")
                return []
            if kind == "message_delta":
                delta = data.get("delta")
                if not _object(delta) or delta.get("stop_reason") != "end_turn" or delta.get("stop_sequence") is not None:
                    raise StreamProtocolError("Messages stream did not finish a text turn")
                self.merge_usage(data.get("usage"))
                self.source_finish = True
                return []
            if kind == "message_stop":
                return self.terminal()
            raise StreamProtocolError("Unsupported Messages event")
        if kind in ("response.created", "response.in_progress"):
            if not _object(data.get("response")) or not _empty_or_missing(data["response"].get("output")):
                raise StreamProtocolError("Responses stream lacks response envelope")
            self.source_started = True
            self.identity(data["response"])
            self.merge_usage(data["response"].get("usage"))
            return self.start()
        if not self.source_started:
            raise StreamProtocolError("Responses stream lacks response.created")
        if kind in ("response.output_item.added", "response.output_item.done"):
            item = data.get("item")
            if data.get("output_index") != 0 or not _object(item) or item.get("type") != "message" or item.get("role") != "assistant":
                raise StreamProtocolError("Non-text Responses output item")
            parts = item.get("content", [])
            if not isinstance(parts, list) or any(not _text_part(part) for part in parts):
                raise StreamProtocolError("Responses output item has unsupported content")
            if kind.endswith(".added") and parts or kind.endswith(".done") and parts and "".join(part["text"] for part in parts) != self.text:
                raise StreamProtocolError("Responses output item changed streamed text")
            return []
        if kind in ("response.content_part.added", "response.content_part.done"):
            part = data.get("part")
            if data.get("output_index") != 0 or data.get("content_index") != 0 or not _text_part(part):
                raise StreamProtocolError("Non-text Responses content part")
            if kind.endswith(".done") and part["text"] != self.text:
                raise StreamProtocolError("Responses content changed after delivery")
            return self.delta(part["text"] if kind.endswith(".added") else "")
        if kind == "response.output_text.delta":
            if data.get("output_index") != 0 or data.get("content_index") != 0 or data.get("logprobs") not in (None, []):
                raise StreamProtocolError("Unexpected Responses text index")
            return self.delta(data.get("delta"))
        if kind == "response.output_text.done":
            if self.text == "" and isinstance(data.get("text"), str):
                return self.delta(data["text"])
            if data.get("text") != self.text:
                raise StreamProtocolError("Responses text changed after delivery")
            return []
        if kind == "response.completed":
            response = data.get("response")
            if not _object(response) or response.get("status") != "completed":
                raise StreamProtocolError("Responses stream did not complete")
            items = response.get("output", [])
            if not isinstance(items, list) or any(not _object(item) or item.get("type") != "message" or item.get("role") != "assistant" or
                not isinstance(item.get("content"), list) or any(not _text_part(part) for part in item["content"]) for item in items):
                raise StreamProtocolError("Responses terminal has non-text output")
            final_text = "".join(part["text"] for item in items for part in item["content"])
            if self.text and final_text != self.text:
                raise StreamProtocolError("Responses terminal changed delivered text")
            self.merge_usage(response.get("usage"))
            out = [] if self.text else self.delta(final_text)
            self.source_finish = True
            return out + self.terminal()
        raise StreamProtocolError("Unsupported Responses event")


def translated_events(records, source, target, model):
    bridge = TextStreamBridge(source, target, model)
    for record in records:
        for event in bridge.feed(record):
            yield event
        if bridge.finished:
            return
    raise StreamProtocolError("Upstream stream ended before its terminal event")
