"""Gateway-first JSON client with opt-in, application-directed local fallback."""

from __future__ import annotations

import json
import hashlib
import os
import socket
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ._stream import StreamEvent, StreamProtocolError, native_events, parse_sse, translated_events


class UnsupportedRequest(ValueError):
    """A request cannot be represented by the selected local target."""


class CallError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class CallResult:
    data: dict
    source: str
    target: str | None = None


PATHS = {"chat": "/v1/chat/completions", "responses": "/v1/responses", "messages": "/v1/messages"}


def _turns(dialect: str, body: dict) -> tuple[list[dict], int | None]:
    allowed = {
        "chat": {"model", "messages", "max_tokens"},
        "responses": {"model", "input", "max_output_tokens"},
        "messages": {"model", "messages", "system", "max_tokens"},
    }
    if dialect not in allowed or set(body) - allowed[dialect]:
        raise UnsupportedRequest("Only plain text turns and output-token limits can be converted locally")
    if dialect == "responses":
        source = body.get("input", [])
        if isinstance(source, str):
            source = [{"role": "user", "content": source}]
    else:
        source = body.get("messages", [])
    if not isinstance(source, list):
        raise UnsupportedRequest("Text messages must be a list")
    turns = []
    if dialect == "messages" and body.get("system"):
        if not isinstance(body["system"], str):
            raise UnsupportedRequest("Only text system instructions can be converted")
        turns.append({"role": "system", "content": body["system"]})
    for item in source:
        if not isinstance(item, dict) or set(item) - {"role", "content"} or item.get("role") not in ("system", "user", "assistant") or not isinstance(item.get("content"), str):
            raise UnsupportedRequest("Only plain text system, user, and assistant turns can be converted")
        turns.append({"role": item["role"], "content": item["content"]})
    if not turns:
        raise UnsupportedRequest("At least one text turn is required")
    limit = body.get("max_output_tokens" if dialect == "responses" else "max_tokens")
    if limit is not None and (type(limit) is not int or limit <= 0):
        raise UnsupportedRequest("Output-token limit must be a positive integer")
    return turns, limit


def _encode(dialect: str, model: str, turns: list[dict], limit: int | None) -> dict:
    if dialect == "chat":
        answer = {"model": model, "messages": turns}
        if limit is not None:
            answer["max_tokens"] = limit
        return answer
    if dialect == "responses":
        answer = {"model": model, "input": turns}
        if limit is not None:
            answer["max_output_tokens"] = limit
        return answer
    if dialect == "messages":
        messages = [turn for turn in turns if turn["role"] != "system"]
        systems = [turn["content"] for turn in turns if turn["role"] == "system"]
        if len(systems) > 1 or (systems and turns[0]["role"] != "system"):
            raise UnsupportedRequest("Only one leading system instruction can be converted to Messages")
        if not messages:
            raise UnsupportedRequest("Messages needs a user or assistant turn")
        answer = {"model": model, "messages": messages, "max_tokens": limit or 1024}
        if systems:
            answer["system"] = "\n".join(systems)
        return answer
    raise UnsupportedRequest("Unknown target dialect")


def _text(dialect: str, body: dict) -> str:
    if dialect == "chat":
        if not isinstance(body.get("choices"), list) or len(body["choices"]) != 1 or not isinstance(body["choices"][0].get("message"), dict):
            raise UnsupportedRequest("Target response is not a plain text answer")
        if body["choices"][0].get("finish_reason") != "stop" or body["choices"][0]["message"].get("tool_calls") or body["choices"][0]["message"].get("refusal"):
            raise UnsupportedRequest("Target response includes unsupported completion semantics")
        value = body["choices"][0]["message"]["content"]
    elif dialect == "messages":
        if not isinstance(body.get("content"), list):
            raise UnsupportedRequest("Target response is not a plain text answer")
        if body.get("stop_reason") != "end_turn" or any(not isinstance(part, dict) or part.get("type") != "text" or not isinstance(part.get("text"), str) or part.get("citations") for part in body["content"]):
            raise UnsupportedRequest("Target response includes unsupported completion semantics")
        value = "".join(part["text"] for part in body["content"])
    else:
        output = body.get("output", [])
        if not isinstance(output, list) or body.get("status") != "completed" or any(not isinstance(item, dict) or item.get("type") != "message" or not isinstance(item.get("content"), list) or any(not isinstance(part, dict) or part.get("type") != "output_text" or not isinstance(part.get("text"), str) or part.get("annotations") for part in item["content"]) for item in output):
            raise UnsupportedRequest("Target response includes unsupported completion semantics")
        value = body.get("output_text")
        if value is not None and output and value != "".join(part["text"] for item in output for part in item["content"]):
            raise UnsupportedRequest("Target response text fields disagree")
        if value is None:
            if not output:
                raise UnsupportedRequest("Target response is not a plain text answer")
            value = "".join(part["text"] for item in output for part in item["content"])
    if not isinstance(value, str):
        raise UnsupportedRequest("Target response is not a plain text answer")
    return value


def _decode(dialect: str, model: str, text: str, source: dict | None = None) -> dict:
    source = source or {}
    response_id = source.get("id") if isinstance(source.get("id"), str) and source["id"] else "local_" + uuid.uuid4().hex
    created = source.get("created", source.get("created_at"))
    if type(created) is not int:
        created = int(time.time())
    observed = source.get("usage")
    tokens = None
    if isinstance(observed, dict):
        input_tokens = observed.get("input_tokens", observed.get("prompt_tokens"))
        output_tokens = observed.get("output_tokens", observed.get("completion_tokens"))
        if type(input_tokens) is int and input_tokens >= 0 and type(output_tokens) is int and output_tokens >= 0:
            tokens = (input_tokens, output_tokens)
    if dialect == "chat":
        answer = {"id": response_id, "created": created, "object": "chat.completion", "model": model, "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}]}
        if tokens:
            answer["usage"] = {"prompt_tokens": tokens[0], "completion_tokens": tokens[1], "total_tokens": sum(tokens)}
        return answer
    if dialect == "messages":
        answer = {"id": response_id, "type": "message", "role": "assistant", "model": model, "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None}
        if tokens:
            answer["usage"] = {"input_tokens": tokens[0], "output_tokens": tokens[1]}
        return answer
    answer = {"id": response_id, "object": "response", "created_at": created, "status": "completed", "model": model, "output": [{"id": "msg_" + response_id, "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]}]}
    if tokens:
        answer["usage"] = {"input_tokens": tokens[0], "output_tokens": tokens[1], "total_tokens": sum(tokens)}
    return answer


def _url(base: str, dialect: str) -> str:
    root = base.rstrip("/")
    if not root.endswith("/v1"):
        root += "/v1"
    return root + {"chat": "/chat/completions", "responses": "/responses", "messages": "/messages"}[dialect]


def _request(url: str, token: str, body: dict | None = None, dialect: str = "chat") -> dict:
    headers = {"Accept": "application/json"}
    if dialect == "messages" and body is not None:
        headers.update({"x-api-key": token, "anthropic-version": "2023-06-01"})
    else:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urlopen(request, timeout=30) as response:
            try:
                result = json.load(response)
            except (ValueError, UnicodeError) as cause:
                raise UnsupportedRequest("Upstream response is not valid JSON") from cause
            if not isinstance(result, dict):
                raise UnsupportedRequest("Upstream response is not a JSON object")
            return result
    except HTTPError as error:
        error.close()
        raise CallError(error.code, "Upstream returned HTTP " + str(error.code)) from error


def _open_stream(url: str, token: str, body: dict, dialect: str, timeout: float):
    headers = {"Accept": "text/event-stream", "Content-Type": "application/json"}
    if dialect == "messages":
        headers.update({"x-api-key": token, "anthropic-version": "2023-06-01"})
    else:
        headers["Authorization"] = "Bearer " + token
    request = Request(url, data=json.dumps(body).encode(), headers=headers)
    try:
        response = urlopen(request, timeout=timeout)
    except HTTPError as error:
        error.close()
        raise CallError(error.code, "Upstream returned HTTP " + str(error.code)) from error
    if not response.headers.get("Content-Type", "").lower().startswith("text/event-stream"):
        response.close()
        raise UnsupportedRequest("Upstream did not open an SSE stream")
    return response


class StreamResult:
    def __init__(self, source: str, target: str | None, response, source_dialect: str, caller_dialect: str, model: str):
        self.source, self.target = source, target
        self._response = response
        self._closed = False
        self._events = (native_events(parse_sse(response), caller_dialect) if source_dialect == caller_dialect
                        else translated_events(parse_sse(response), source_dialect, caller_dialect, model))

    def __iter__(self):
        try:
            while True:
                if self._closed:
                    raise StreamProtocolError("Stream was cancelled")
                try:
                    event = next(self._events)
                except StopIteration:
                    return
                if self._closed:
                    raise StreamProtocolError("Stream was cancelled")
                yield event
        finally:
            self.close()

    def close(self):
        self._closed = True
        self._response.close()

    cancel = close

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class Client:
    def __init__(self, url: str, key: str, cache_path: str | Path, local_targets,
                 should_try_next=lambda error, target: False,
                 is_gateway_unavailable=lambda error: False, stream_idle_timeout: float = 30):
        if stream_idle_timeout <= 0:
            raise ValueError("stream_idle_timeout must be positive")
        self.url = url.rstrip("/")
        self.key = key
        self.cache_path = Path(cache_path)
        self.local_targets = local_targets
        self.should_try_next = should_try_next
        self.is_gateway_unavailable = is_gateway_unavailable
        self.stream_idle_timeout = stream_idle_timeout
        self._lock = threading.Lock()
        self._fetching = False
        self._last_fetch_attempt = 0.0
        self._cache_owner = hashlib.sha256((self.url + "\0" + key).encode()).hexdigest()
        self._snapshot = None
        if self.cache_path.exists():
            self._snapshot = json.loads(self.cache_path.read_text(encoding="utf-8"))
            if self._snapshot.get("cache_owner") != self._cache_owner:
                raise ValueError("Saved snapshot belongs to a different gateway or key")

    def refresh(self) -> dict:
        snapshot = _request(self.url + "/v1/client-snapshot", self.key)
        if snapshot.get("version") != 1 or not isinstance(snapshot.get("selectors"), dict) or not isinstance(snapshot.get("targets"), dict):
            raise ValueError("Unsupported client snapshot")
        snapshot["fetched_unix"] = time.time()
        snapshot["cache_owner"] = self._cache_owner
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=self.cache_path.parent, prefix=".snapshot-")
        try:
            os.chmod(name, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(snapshot, file)
            os.replace(name, self.cache_path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        with self._lock:
            self._snapshot = snapshot
        return snapshot

    def _refresh_if_stale(self):
        with self._lock:
            now = time.time()
            if self._fetching or now - self._last_fetch_attempt < 60 or (self._snapshot and now - self._snapshot.get("fetched_unix", 0) <= 3600):
                return
            self._fetching = True
            self._last_fetch_attempt = now

        def run():
            try:
                self.refresh()
            except (OSError, ValueError, CallError):
                pass  # Keep the last successful snapshot.
            finally:
                with self._lock:
                    self._fetching = False

        threading.Thread(target=run, daemon=True).start()

    def call(self, dialect: str, selector: str, body: dict) -> dict:
        return self.call_with_info(dialect, selector, body).data

    def call_with_info(self, dialect: str, selector: str, body: dict) -> CallResult:
        if dialect not in PATHS:
            raise ValueError("Unknown caller dialect")
        if body.get("stream"):
            raise UnsupportedRequest("Use stream() for streaming output")
        self._refresh_if_stale()
        request_body = {**body, "model": selector}
        try:
            return CallResult(_request(self.url + PATHS[dialect], self.key, request_body, dialect), "gateway")
        except CallError as error:
            if error.status not in (502, 503, 504) or not self.is_gateway_unavailable(error):
                raise
        except URLError as error:
            if not isinstance(error.reason, (ConnectionRefusedError, socket.gaierror)):
                raise
        snapshot = self._snapshot
        if not snapshot:
            raise RuntimeError("Gateway unavailable and no local snapshot is saved")
        entry = snapshot["selectors"].get(selector)
        if not entry:
            raise RuntimeError("Selector is not available in the saved snapshot")
        if entry.get("ingress") and PATHS[dialect] not in entry["ingress"]:
            raise UnsupportedRequest("This route does not permit the caller dialect")
        allowed = set(entry["targets"])
        last_error = None
        for target_id in self.local_targets(selector, dialect):
            if target_id not in allowed:
                raise RuntimeError("Local target is not permitted for this selector")
            target = snapshot["targets"][target_id]
            try:
                if target.get("expires_at") and time.time() >= target["expires_at"]:
                    raise UnsupportedRequest("Local credential has expired")
                native = target["dialect"]
                if native != dialect and not entry.get("allow_adaptation"):
                    raise UnsupportedRequest("Conversion is not allowed for this selector")
                if native == dialect:
                    outbound = {**request_body, "model": target["model"]}
                else:
                    turns, limit = _turns(dialect, request_body)
                    outbound = _encode(native, target["model"], turns, limit)
                response = _request(_url(target["base_url"], native), target["api_key"], outbound, native)
                data = response if native == dialect else _decode(dialect, selector, _text(native, response), response)
                return CallResult(data, "direct", target_id)
            except (UnsupportedRequest, CallError, URLError) as error:
                last_error = error
                if not self.should_try_next(error, target_id):
                    raise
        raise last_error or RuntimeError("No local targets were selected")

    def stream(self, dialect: str, selector: str, body: dict) -> StreamResult:
        if dialect not in PATHS:
            raise ValueError("Unknown caller dialect")
        if body.get("stream") is False:
            raise UnsupportedRequest("stream() requires streaming output")
        self._refresh_if_stale()
        input_body = {**body, "model": selector, "stream": True}
        try:
            opened = _open_stream(self.url + PATHS[dialect], self.key, input_body, dialect, self.stream_idle_timeout)
            return StreamResult("gateway", None, opened, dialect, dialect, selector)
        except CallError as error:
            if error.status not in (502, 503, 504) or not self.is_gateway_unavailable(error):
                raise
        except URLError as error:
            if not isinstance(error.reason, (ConnectionRefusedError, socket.gaierror)):
                raise
        snapshot = self._snapshot
        if not snapshot:
            raise RuntimeError("Gateway unavailable and no local snapshot is saved")
        entry = snapshot["selectors"].get(selector)
        if not entry:
            raise RuntimeError("Selector is not available in the saved snapshot")
        if entry.get("ingress") and PATHS[dialect] not in entry["ingress"]:
            raise UnsupportedRequest("This route does not permit the caller dialect")
        allowed = set(entry["targets"])
        last_error = None
        for target_id in self.local_targets(selector, dialect):
            if target_id not in allowed:
                raise RuntimeError("Local target is not permitted for this selector")
            target = snapshot["targets"][target_id]
            try:
                if target.get("expires_at") and time.time() >= target["expires_at"]:
                    raise UnsupportedRequest("Local credential has expired")
                native = target["dialect"]
                if native != dialect and not entry.get("allow_adaptation"):
                    raise UnsupportedRequest("Conversion is not allowed for this selector")
                if native == dialect:
                    outbound = {**input_body, "model": target["model"]}
                else:
                    shape = {**body, "model": selector}
                    shape.pop("stream", None)
                    turns, limit = _turns(dialect, shape)
                    outbound = {**_encode(native, target["model"], turns, limit), "stream": True}
                opened = _open_stream(_url(target["base_url"], native), target["api_key"], outbound, native, self.stream_idle_timeout)
                return StreamResult("direct", target_id, opened, native, dialect, selector)
            except (UnsupportedRequest, CallError, URLError) as error:
                last_error = error
                if not self.should_try_next(error, target_id):
                    raise
        raise last_error or RuntimeError("No local targets were selected")
