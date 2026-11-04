import json
import io
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from llmgw_client import CallError, Client, StreamProtocolError
from llmgw_client._stream import StreamEvent, native_events, parse_sse, translated_events


def fixtures():
    message = {"id": "msg_src", "role": "assistant", "type": "message", "content": [{"type": "output_text", "text": "hello"}]}
    return {
        "chat": [
            StreamEvent("message", {"id": "chat_src", "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}),
            StreamEvent("message", {"choices": [{"index": 0, "delta": {"content": "hel"}, "finish_reason": None}]}),
            StreamEvent("message", {"choices": [{"index": 0, "delta": {"content": "lo"}, "finish_reason": "stop"}]}),
            StreamEvent("message", {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 2}}),
            StreamEvent("message", "[DONE]"),
        ],
        "messages": [
            StreamEvent("message_start", {"type": "message_start", "message": {"id": "msg_src", "role": "assistant", "usage": {"input_tokens": 5}}}),
            StreamEvent("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            StreamEvent("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hel"}}),
            StreamEvent("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "lo"}}),
            StreamEvent("content_block_stop", {"type": "content_block_stop", "index": 0}),
            StreamEvent("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}}),
            StreamEvent("message_stop", {"type": "message_stop"}),
        ],
        "responses": [
            StreamEvent("response.created", {"type": "response.created", "response": {"id": "resp_src", "status": "in_progress", "output": []}}),
            StreamEvent("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**message, "content": []}}),
            StreamEvent("response.content_part.added", {"type": "response.content_part.added", "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": ""}}),
            StreamEvent("response.output_text.delta", {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "hel"}),
            StreamEvent("response.output_text.delta", {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "lo"}),
            StreamEvent("response.output_text.done", {"type": "response.output_text.done", "text": "hello"}),
            StreamEvent("response.content_part.done", {"type": "response.content_part.done", "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "hello"}}),
            StreamEvent("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": message}),
            StreamEvent("response.completed", {"type": "response.completed", "response": {"id": "resp_src", "status": "completed", "output": [message], "usage": {"input_tokens": 5, "output_tokens": 2}}}),
        ],
    }


def wire(records):
    return b"".join((f"event: {item.event}\r\n" if item.event != "message" else "").encode() +
                    ("data: " + (item.data if isinstance(item.data, str) else json.dumps(item.data)) + "\r\n\r\n").encode()
                    for item in records)


def deltas(events, dialect):
    if dialect == "chat":
        return "".join(item.data.get("choices", [{}])[0].get("delta", {}).get("content", "")
                       for item in events if isinstance(item.data, dict) and item.data.get("choices"))
    if dialect == "messages":
        return "".join(item.data["delta"]["text"] for item in events if isinstance(item.data, dict) and item.data.get("type") == "content_block_delta")
    return "".join(item.data["delta"] for item in events if isinstance(item.data, dict) and item.data.get("type") == "response.output_text.delta")


class StreamTests(unittest.TestCase):
    def test_nine_directed_text_stream_pairs_and_truncation(self):
        for source, records in fixtures().items():
            for target in fixtures():
                with self.subTest(source=source, target=target):
                    stream = native_events(iter(records), source) if source == target else translated_events(iter(records), source, target, "coding")
                    result = list(stream)
                    self.assertEqual(deltas(result, target), "hello")
                    terminal = "[DONE]" if target == "chat" else "message_stop" if target == "messages" else "response.completed"
                    self.assertEqual(result[-1].data if target == "chat" else result[-1].event, terminal)
                    if target == "responses" and source != target:
                        self.assertEqual([event.data["sequence_number"] for event in result], list(range(len(result))))
                        self.assertEqual(result[-1].data["response"]["output"][0]["content"][0]["text"], "hello")
                        self.assertEqual(result[-1].data["response"]["usage"], {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7})
                    if source != target:
                        with self.assertRaises(StreamProtocolError):
                            list(translated_events(iter(records[:-1]), source, target, "coding"))

    def test_error_after_text_has_no_success_terminal(self):
        records = fixtures()["messages"][:3] + [StreamEvent("error", {"type": "error", "error": {"type": "api_error"}})]
        result = []
        with self.assertRaises(StreamProtocolError):
            for item in translated_events(iter(records), "messages", "chat", "coding"):
                result.append(item)
        self.assertEqual(deltas(result, "chat"), "hel")
        self.assertFalse(any(item.data == "[DONE]" for item in result))

    def test_native_tool_stream_is_preserved_but_cross_dialect_refused(self):
        tool = [StreamEvent("message", {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "call_1"}]}, "finish_reason": "tool_calls"}]}),
                StreamEvent("message", "[DONE]")]
        self.assertEqual(list(native_events(iter(tool), "chat"))[0].data["choices"][0]["delta"]["tool_calls"][0]["id"], "call_1")
        translated = []
        with self.assertRaises(StreamProtocolError):
            for item in translated_events(iter(tool), "chat", "messages", "coding"):
                translated.append(item)
        self.assertFalse(any(item.event == "message_stop" for item in translated))

    def test_citation_is_not_silently_dropped(self):
        records = fixtures()["responses"]
        records[6] = StreamEvent("response.content_part.done", {"type": "response.content_part.done", "output_index": 0, "content_index": 0,
            "part": {"type": "output_text", "text": "hello", "annotations": [{"type": "file_citation"}]}})
        output = []
        with self.assertRaises(StreamProtocolError):
            for event in translated_events(iter(records), "responses", "messages", "coding"):
                output.append(event)
        self.assertFalse(any(item.event == "message_stop" for item in output))
        records = fixtures()["responses"]
        records[7] = StreamEvent("response.output_item.done", {"type": "response.output_item.done", "output_index": 0,
            "item": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hello", "annotations": [{"type": "file_citation"}]}]}})
        with self.assertRaises(StreamProtocolError):
            list(translated_events(iter(records), "responses", "chat", "coding"))

    def test_responses_done_supplies_text_when_no_delta_arrives(self):
        records = [item for item in fixtures()["responses"] if item.event != "response.output_text.delta"]
        output = list(translated_events(iter(records), "responses", "chat", "coding"))
        self.assertEqual(deltas(output, "chat"), "hello")
        self.assertEqual(output[-1].data, "[DONE]")

    def test_malformed_sse_data_does_not_complete(self):
        with self.assertRaises(StreamProtocolError):
            list(parse_sse(io.BytesIO(b"data: {broken}\n\n")))


class HTTPStreamHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.respond(self.server.snapshot)

    def do_POST(self):
        _ = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.attempts += 1
        if self.server.down:
            self.respond({"error": "gateway offline"}, self.server.down_status)
            return
        self.server.calls += 1
        data = wire(fixtures()[self.server.dialect] if not self.server.failed else fixtures()[self.server.dialect][:3] +
                    [StreamEvent("error", {"type": "error", "error": {"type": "api_error"}})])
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.server.stall:
            first = data.find(b"\r\n\r\n") + 4
            self.wfile.write(data[:first])
            self.wfile.flush()
            time.sleep(0.15)
            data = data[first:]
        for offset in range(0, len(data), 13):
            try:
                self.wfile.write(data[offset:offset + 13])
                self.wfile.flush()
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                return  # Intentional client cancellation ends this fixture request.

    def respond(self, data, status=200):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


class HTTPStreamTests(unittest.TestCase):
    def serve(self, dialect, snapshot=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), HTTPStreamHandler)
        server.dialect, server.snapshot, server.down, server.down_status, server.failed, server.calls, server.attempts, server.stall = dialect, snapshot, False, 503, False, 0, 0, False
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server, f"http://127.0.0.1:{server.server_port}"

    def test_gateway_native_then_local_cross_dialect_and_opened_error(self):
        local, direct = self.serve("messages")
        other, other_url = self.serve("chat")
        refused, refused_url = self.serve("messages")
        refused.down = True
        snapshot = {"version": 1, "selectors": {"coding": {"targets": ["refused/model", "local/model", "other/model"], "allow_adaptation": True,
            "ingress": ["/v1/chat/completions"]}}, "targets": {
                "refused/model": {"model": "model", "dialect": "messages", "base_url": refused_url, "api_key": "fixture"},
                "local/model": {"model": "model", "dialect": "messages", "base_url": direct, "api_key": "fixture"},
                "other/model": {"model": "model", "dialect": "chat", "base_url": other_url, "api_key": "fixture"},
            }}
        gateway, url = self.serve("chat", snapshot)
        with tempfile.TemporaryDirectory() as directory:
            client = Client(url, "project-key", Path(directory) / "cache.json", lambda *_: ["refused/model", "local/model", "other/model"],
                            should_try_next=lambda *_: True, is_gateway_unavailable=lambda error: error.status == 503)
            client.refresh()
            request = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 32}
            with client.stream("chat", "coding", request) as online:
                self.assertEqual(online.source, "gateway")
                self.assertEqual(deltas(list(online), "chat"), "hello")
            gateway.down = True
            with client.stream("chat", "coding", {**request, "stream": True}) as offline:
                self.assertEqual((offline.source, offline.target), ("direct", "local/model"))
                self.assertEqual(refused.attempts, 1)
                converted = list(offline)
            self.assertEqual(deltas(converted, "chat"), "hello")
            self.assertEqual(converted[-1].data, "[DONE]")
            cancelled = client.stream("chat", "coding", request)
            iterator = iter(cancelled)
            next(iterator)
            cancelled.cancel()
            with self.assertRaises(StreamProtocolError):
                next(iterator)
            local.failed = True
            with client.stream("chat", "coding", request) as partial:
                seen = []
                with self.assertRaises(StreamProtocolError):
                    for event in partial:
                        seen.append(event)
            self.assertEqual(deltas(seen, "chat"), "hel")
            self.assertEqual(other.calls, 0, "opened stream cannot advance to another target")
            self.assertEqual(refused.attempts, 3)
            gateway.down_status = 401
            client.is_gateway_unavailable = lambda error: True
            with self.assertRaises(CallError) as denied:
                client.stream("chat", "coding", request)
            self.assertEqual(denied.exception.status, 401)
            self.assertEqual(refused.attempts, 3, "gateway authentication refusal cannot enter local mode")

    def test_stream_idle_timeout_is_reported(self):
        gateway, url = self.serve("chat", {"version": 1, "selectors": {}, "targets": {}})
        gateway.stall = True
        with tempfile.TemporaryDirectory() as directory:
            client = Client(url, "project-key", Path(directory) / "cache.json", lambda *_: [], stream_idle_timeout=0.02)
            with client.stream("chat", "coding", {"messages": [{"role": "user", "content": "hi"}]}) as stream:
                events = iter(stream)
                next(events)
                with self.assertRaisesRegex(StreamProtocolError, "idle timeout"):
                    next(events)


if __name__ == "__main__":
    unittest.main()
