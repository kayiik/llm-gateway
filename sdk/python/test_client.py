import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from llmgw_client import CallError, Client, UnsupportedRequest, _decode, _encode, _text, _turns


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_json(self.server.snapshot)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.calls.append((self.path, body))
        if self.server.gateway_status:
            self.send_json({"error": "unavailable"}, self.server.gateway_status)
        elif self.server.reject:
            self.send_json({"error": "rejected"}, 401)
        elif self.path.endswith("/messages"):
            self.send_json({"type": "message", "stop_reason": "end_turn", "content": [{"type": "text", "text": "hello"}]})
        elif self.path.endswith("/responses"):
            self.send_json({"object": "response", "status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": "hello"}]}]})
        else:
            self.send_json({"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "hello"}}]})

    def send_json(self, value, status=200):
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.servers = []
        self.bad = self.serve(reject=True)
        self.good = self.serve()
        self.snapshot = {
            "version": 1,
            "selectors": {"coding": {"allow_adaptation": True, "targets": ["bad/model", "good/model"]}},
            "targets": {
                "bad/model": {"dialect": "chat", "base_url": self.bad, "api_key": "bad-key", "model": "model"},
                "good/model": {"dialect": "messages", "base_url": self.good, "api_key": "good-key", "model": "model"},
            },
        }
        self.gateway = self.serve(snapshot=self.snapshot)

    def serve(self, reject=False, snapshot=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.reject, server.snapshot, server.calls, server.gateway_status = reject, snapshot, [], 0
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append(server)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def client(self, targets, next_on_error=lambda error, target: False):
        return Client(self.gateway, "project-key", Path(self.temp.name) / "snapshot.json", targets, next_on_error)

    def test_gateway_first_and_saved_local_cascade(self):
        client = self.client(lambda selector, dialect: ["bad/model", "good/model"],
                             lambda error, target: isinstance(error, CallError) and error.status == 401)
        client.refresh()
        with self.assertRaisesRegex(ValueError, "different gateway or key"):
            Client(self.gateway, "another-project-key", client.cache_path, lambda selector, dialect: ["good/model"])
        with self.assertRaisesRegex(ValueError, "different gateway or key"):
            Client("http://127.0.0.1:1", "project-key", client.cache_path, lambda selector, dialect: ["good/model"])
        body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 32}
        online = client.call_with_info("chat", "coding", body)
        self.assertEqual(online.data["choices"][0]["message"]["content"], "hello")
        self.assertEqual((online.source, online.target), ("gateway", None))
        self.assertEqual(len(self.bad_server_calls()), 0)
        self.servers[-1].shutdown()
        self.servers[-1].server_close()
        offline = client.call_with_info("chat", "coding", body)
        self.assertEqual(offline.data["choices"][0]["message"]["content"], "hello")
        self.assertEqual((offline.source, offline.target), ("direct", "good/model"))
        self.assertEqual(self.servers[0].calls[0][0], "/v1/chat/completions")
        self.assertEqual(self.servers[1].calls[0][1]["messages"], [{"role": "user", "content": "hi"}])
        self.assertEqual(self.client(lambda selector, dialect: ["good/model"]).call("responses", "coding", {"input": "hi"})["output"][0]["content"][0]["text"], "hello")

    def bad_server_calls(self):
        return self.servers[0].calls

    def test_conversion_is_bounded(self):
        client = self.client(lambda selector, dialect: ["good/model"])
        client.refresh()
        self.servers[-1].shutdown()
        self.servers[-1].server_close()
        with self.assertRaises(UnsupportedRequest):
            client.call("chat", "coding", {"messages": [{"role": "user", "content": "hi"}], "tools": [{"type": "function"}]})
        self.assertEqual(len(self.servers[1].calls), 0)
        client._snapshot["selectors"]["coding"]["ingress"] = ["/v1/messages"]
        with self.assertRaises(UnsupportedRequest):
            client.call("chat", "coding", {"messages": [{"role": "user", "content": "hi"}]})
        client._snapshot["selectors"]["coding"].pop("ingress")
        client._snapshot["targets"]["good/model"]["expires_at"] = 1
        with self.assertRaises(UnsupportedRequest):
            client.call("chat", "coding", {"messages": [{"role": "user", "content": "hi"}]})

    def test_plain_text_conversion_matrix(self):
        inputs = {
            "chat": {"model": "coding", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 32},
            "responses": {"model": "coding", "input": "hi", "max_output_tokens": 32},
            "messages": {"model": "coding", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 32},
        }
        answers = {
            "chat": {"choices": [{"finish_reason": "stop", "message": {"content": "hello"}}]},
            "responses": {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": "hello"}]}]},
            "messages": {"stop_reason": "end_turn", "content": [{"type": "text", "text": "hello"}]},
        }
        for ingress, payload in inputs.items():
            for target, answer in answers.items():
                with self.subTest(ingress=ingress, target=target):
                    turns, limit = _turns(ingress, payload)
                    outbound = _encode(target, "native", turns, limit)
                    self.assertEqual(outbound["model"], "native")
                    self.assertEqual(_text(target, answer), "hello")
                    converted = _decode(ingress, "coding", _text(target, answer))
                    self.assertEqual(_text(ingress, converted), "hello")
        observed = _decode("messages", "coding", "hello", {"id": "chat_fixture", "created": 10,
                                                      "usage": {"prompt_tokens": 5, "completion_tokens": 2}})
        self.assertEqual(observed["id"], "chat_fixture")
        self.assertEqual(observed["usage"], {"input_tokens": 5, "output_tokens": 2})
        with self.assertRaises(UnsupportedRequest):
            _text("messages", {"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "run"}]})
        with self.assertRaises(UnsupportedRequest):
            _text("responses", {"status": "completed", "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "partial"}]},
                {"type": "function_call", "name": "run"},
            ]})
        with self.assertRaises(UnsupportedRequest):
            _text("responses", {"status": "completed", "output": [{"type": "message", "content": [
                {"type": "output_text", "text": "hello", "annotations": [{"type": "citation"}]}]}]})
        with self.assertRaises(UnsupportedRequest):
            _text("chat", {"choices": [{"message": {"content": "possibly partial"}}]})
        with self.assertRaises(UnsupportedRequest):
            _encode("messages", "native", [{"role": "user", "content": "hi"}, {"role": "system", "content": "late"}], 32)
        with self.assertRaises(UnsupportedRequest):
            _turns("chat", {"model": "coding", "messages": [{"role": "assistant", "content": "hi", "tool_calls": [{"id": "tool"}]}]})

    def test_proxy_outage_requires_an_explicit_decision(self):
        default = self.client(lambda selector, dialect: ["good/model"])
        default.refresh()
        self.servers[-1].gateway_status = 503
        payload = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 32}
        with self.assertRaises(CallError) as refused:
            default.call("chat", "coding", payload)
        self.assertEqual(refused.exception.status, 503)
        self.assertEqual(len(self.servers[1].calls), 0)
        opted_in = Client(self.gateway, "project-key", default.cache_path,
                          lambda selector, dialect: ["good/model"],
                          is_gateway_unavailable=lambda error: error.status == 503)
        self.assertEqual(opted_in.call("chat", "coding", payload)["choices"][0]["message"]["content"], "hello")
        self.servers[-1].gateway_status = 401
        with self.assertRaises(CallError) as unauthorized:
            opted_in.call("chat", "coding", payload)
        self.assertEqual(unauthorized.exception.status, 401)


if __name__ == "__main__":
    unittest.main()
