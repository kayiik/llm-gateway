package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"llmgw/internal/config"
	"llmgw/internal/providers"
)

func TestPublicHTTPStreamingToolConversations(t *testing.T) {
	for _, wire := range []string{"chat", "responses", "messages"} {
		for _, ingress := range []string{"chat", "responses", "messages"} {
			for _, route := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s-to-%s/route=%v", ingress, wire, route), func(t *testing.T) {
					f := newNativePolicyFixture(t)
					wirePath := map[string]string{"chat": "/chat/completions", "responses": "/responses", "messages": "/v1/messages"}[wire]
					f.catalogSurfaces = []string{wirePath}
					config.Update(func(s *config.Settings) {
						s.APIKey = "gateway-token"
						s.Providers["chat"].RegistryID = "openrouter"
						s.Providers["responses"].ForceApiSupport = true
						s.Endpoints["conversation"] = &config.EndpointConfig{Failover: []config.EndpointMember{{Provider: wire, Model: "fixture"}}, Ingress: []string{"/v1/chat/completions", "/v1/responses", "/v1/messages"}, AllowAdaptation: true}
					})
					if wire != "messages" {
						providers.RefreshCatalog(wire)
					}
					var calls atomic.Int32
					f.inference = func(w http.ResponseWriter, r *http.Request, body map[string]any) {
						stage := calls.Add(1)
						if r.URL.Path != wirePath || body["model"] != "fixture" || body["stream"] != true {
							t.Errorf("wrong streaming target: path=%s body=%+v", r.URL.Path, body)
						}
						if stage == 2 {
							assertConversationToolResult(t, wire, body)
						}
						reply := conversationReply(wire, stage == 2)
						if ingress != wire {
							reply = adaptableConversationReply(wire, stage == 2)
						}
						writeConversationStreamReply(w, wire, stage == 2, reply)
					}
					model, permission := wire+"/fixture", "allow"
					if route {
						model, permission = "conversation", ""
					}
					path := map[string]string{"chat": "/v1/chat/completions", "responses": "/v1/responses", "messages": "/v1/messages"}[ingress]
					first := conversationRequest(ingress, model, nil)
					first["stream"] = true
					if ingress == "chat" {
						first["stream_options"] = map[string]any{"include_usage": true}
					}
					status, raw := cliRequest(t, f.server.URL+path, first, permission)
					if ingress == "responses" && wire == "messages" {
						if status != http.StatusBadRequest || calls.Load() != 0 || !bytes.Contains(raw, []byte("request_loss")) || !bytes.Contains(raw, []byte("strict")) {
							t.Fatalf("unsupported strict-tool stream was not refused: status=%d calls=%d body=%s", status, calls.Load(), raw)
						}
						return
					}
					if status != http.StatusOK {
						t.Fatalf("first stream status=%d body=%s", status, raw)
					}
					if ingress == "responses" && ingress == wire && !bytes.Contains(raw, []byte(`"vendor_request_id":"trace"`)) {
						t.Fatalf("native stream metadata changed: %s", raw)
					}
					answer := readConversationStream(t, ingress, raw, false)
					assertConversationCall(t, ingress, answer)
					second := conversationRequest(ingress, model, answer)
					second["stream"] = true
					if ingress == "chat" {
						second["stream_options"] = map[string]any{"include_usage": true}
					}
					status, raw = cliRequest(t, f.server.URL+path, second, permission)
					if status != http.StatusOK {
						t.Fatalf("result stream status=%d body=%s", status, raw)
					}
					assertConversationFinal(t, ingress, readConversationStream(t, ingress, raw, true))
					if calls.Load() != 2 {
						t.Fatalf("attempts=%d want two", calls.Load())
					}
				})
			}
		}
	}
}

func TestContainerMessagesStreamingRegressions(t *testing.T) {
	for _, ingress := range []string{"chat", "responses"} {
		t.Run(ingress, func(t *testing.T) {
			f := newNativePolicyFixture(t)
			config.Update(func(s *config.Settings) { s.APIKey = "gateway-token" })
			var calls atomic.Int32
			f.inference = func(w http.ResponseWriter, r *http.Request, body map[string]any) {
				stage := calls.Add(1)
				if stage == 2 {
					messages, _ := body["messages"].([]any)
					foundCall, foundResult := false, false
					for _, raw := range messages {
						message := raw.(map[string]any)
						parts, _ := message["content"].([]any)
						for _, rawPart := range parts {
							part := rawPart.(map[string]any)
							if part["type"] == "tool_use" {
								foundCall = message["role"] == "assistant" && part["id"] == "call_fixture" && part["name"] == "lookup" && jsonStr(part["input"]) == `{"q":"fixture"}`
							}
							if part["type"] == "tool_result" {
								foundResult = part["tool_use_id"] == "call_fixture" && part["content"] == "result-fixture"
							}
						}
					}
					if !foundCall || !foundResult {
						t.Errorf("Messages call/result association changed: %+v", body)
					}
				}
				writeConversationStream(w, "messages", stage == 2, ingress == "responses")
			}
			first := conversationRequest(ingress, "messages/fixture", nil)
			first["stream"] = true
			if ingress == "chat" {
				first["stream_options"] = map[string]any{"include_usage": true}
			}
			path := map[string]string{"chat": "/v1/chat/completions", "responses": "/v1/responses"}[ingress]
			status, raw := cliRequest(t, f.server.URL+path, first, "allow")
			if ingress == "responses" && status == http.StatusBadRequest && calls.Load() == 0 && bytes.Contains(raw, []byte("request_loss")) && bytes.Contains(raw, []byte("strict")) {
				t.Skip("Responses strict-tool conversion is refused before inference; completed-output replay regression was not exercised")
			}
			if status != http.StatusOK {
				t.Fatalf("first status=%d body=%s", status, raw)
			}
			answer := readConversationStream(t, ingress, raw, false)
			assertConversationCall(t, ingress, answer)
			if ingress == "responses" {
				// Replay the actual completed output, including its empty text item,
				// rather than reconstructing just the function call in the observer.
				for _, line := range strings.Split(string(raw), "\n") {
					if !strings.HasPrefix(line, "data: {") {
						continue
					}
					var event map[string]any
					if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
						t.Fatal(err)
					}
					if event["type"] == "response.completed" {
						answer["output"] = event["response"].(map[string]any)["output"]
					}
				}
			}
			second := conversationRequest(ingress, "messages/fixture", answer)
			second["stream"] = true
			if ingress == "chat" {
				second["stream_options"] = map[string]any{"include_usage": true}
			}
			status, raw = cliRequest(t, f.server.URL+path, second, "allow")
			if status != http.StatusOK {
				t.Fatalf("continuation status=%d body=%s", status, raw)
			}
			assertConversationFinal(t, ingress, readConversationStream(t, ingress, raw, true))
			if calls.Load() != 2 {
				t.Fatalf("attempts=%d want two", calls.Load())
			}
		})
	}
}

func writeConversationStream(w http.ResponseWriter, wire string, final bool, cacheDetails ...bool) {
	writeConversationStreamReply(w, wire, final, conversationReply(wire, final), cacheDetails...)
}

func writeConversationStreamReply(w http.ResponseWriter, wire string, final bool, reply map[string]any, cacheDetails ...bool) {
	w.Header().Set("Content-Type", "text/event-stream")
	write := func(kind string, value map[string]any) {
		if kind != "" {
			_, _ = fmt.Fprintf(w, "event: %s\n", kind)
		}
		_, _ = fmt.Fprintf(w, "data: %s\n\n", jsonStr(value))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	switch wire {
	case "chat":
		chunk := func(delta map[string]any, finish any) {
			write("", map[string]any{"id": "chat_fixture", "object": "chat.completion.chunk", "model": "fixture", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
		}
		chunk(map[string]any{"role": "assistant"}, nil)
		if final {
			chunk(map[string]any{"content": "complete-"}, nil)
			chunk(map[string]any{"content": "fixture"}, nil)
			chunk(map[string]any{}, "stop")
		} else {
			chunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_fixture", "type": "function", "function": map[string]any{"name": "lookup", "arguments": `{"q":`}}}}, nil)
			chunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]any{"arguments": `"fixture"}`}}}}, nil)
			chunk(map[string]any{}, "tool_calls")
		}
		write("", map[string]any{"id": "chat_fixture", "object": "chat.completion.chunk", "model": "fixture", "choices": []any{}, "usage": reply["usage"]})
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	case "messages":
		usage := reply["usage"].(map[string]any)
		startUsage := map[string]any{"input_tokens": usage["input_tokens"], "output_tokens": 0}
		if len(cacheDetails) == 0 || cacheDetails[0] {
			startUsage["cache_read_input_tokens"], startUsage["cache_creation_input_tokens"] = 0, 0
		}
		write("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_fixture", "type": "message", "role": "assistant", "model": "fixture", "content": []any{}, "stop_reason": nil, "usage": startUsage}})
		if final {
			write("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
			for _, text := range []string{"complete-", "fixture"} {
				write("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}})
			}
		} else {
			write("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "call_fixture", "name": "lookup", "input": map[string]any{}}})
			for _, part := range []string{`{"q":`, `"fixture"}`} {
				write("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": part}})
			}
		}
		write("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		write("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": reply["stop_reason"], "stop_sequence": nil}, "usage": map[string]any{"output_tokens": usage["output_tokens"]}})
		write("message_stop", map[string]any{"type": "message_stop"})
	default:
		sequence := 0
		emit := func(kind string, fields map[string]any) {
			fields["type"], fields["sequence_number"] = kind, sequence
			sequence++
			write(kind, fields)
		}
		emit("response.created", map[string]any{"response": map[string]any{"id": "resp_fixture", "object": "response", "status": "in_progress", "model": "fixture", "output": []any{}}})
		item := reply["output"].([]any)[0].(map[string]any)
		if final {
			emit("response.output_item.added", map[string]any{"output_index": 0, "item": map[string]any{"id": item["id"], "type": "message", "role": "assistant", "status": "in_progress", "content": []any{}}})
			emit("response.content_part.added", map[string]any{"item_id": item["id"], "output_index": 0, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}})
			for _, text := range []string{"complete-", "fixture"} {
				emit("response.output_text.delta", map[string]any{"item_id": item["id"], "output_index": 0, "content_index": 0, "delta": text})
			}
			emit("response.output_text.done", map[string]any{"item_id": item["id"], "output_index": 0, "content_index": 0, "text": "complete-fixture"})
			emit("response.content_part.done", map[string]any{"item_id": item["id"], "output_index": 0, "content_index": 0, "part": item["content"].([]any)[0]})
		} else {
			emit("response.output_item.added", map[string]any{"output_index": 0, "item": map[string]any{"id": item["id"], "type": "function_call", "call_id": "call_fixture", "name": "lookup", "arguments": "", "status": "in_progress"}})
			for _, part := range []string{`{"q":`, `"fixture"}`} {
				emit("response.function_call_arguments.delta", map[string]any{"item_id": item["id"], "output_index": 0, "delta": part})
			}
			emit("response.function_call_arguments.done", map[string]any{"item_id": item["id"], "output_index": 0, "arguments": item["arguments"]})
		}
		emit("response.output_item.done", map[string]any{"output_index": 0, "item": item})
		emit("response.completed", map[string]any{"response": reply})
	}
}

// This observer reads public SSE directly, independently of production converters.
func readConversationStream(t *testing.T, ingress string, raw []byte, final bool) map[string]any {
	t.Helper()
	var id, name, arguments, text, finish string
	var input, output float64
	terminal, done, deltas := 0, 0, 0
	usage := func(m map[string]any, in, out string) {
		if v, ok := m[in].(float64); ok {
			input = v
		}
		if v, ok := m[out].(float64); ok {
			output = v
		}
	}
	fragment := func(part string, tool bool) {
		if part == "" {
			return
		}
		if terminal != 0 {
			t.Fatalf("delta after terminal: %s", raw)
		}
		deltas++
		if tool {
			if id == "" || name == "" {
				t.Fatalf("arguments before identity: %s", raw)
			}
			arguments += part
		} else {
			text += part
		}
	}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			done++
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			t.Fatalf("bad SSE JSON: %v: %s", err, data)
		}
		if event["error"] != nil || event["type"] == "error" {
			t.Fatalf("stream error: %s", raw)
		}
		switch ingress {
		case "chat":
			if m, ok := event["usage"].(map[string]any); ok {
				usage(m, "prompt_tokens", "completion_tokens")
			}
			for _, c := range event["choices"].([]any) {
				choice := c.(map[string]any)
				delta, _ := choice["delta"].(map[string]any)
				if s, ok := delta["content"].(string); ok {
					fragment(s, false)
				}
				calls, _ := delta["tool_calls"].([]any)
				for _, c := range calls {
					call := c.(map[string]any)
					fn, _ := call["function"].(map[string]any)
					if s, ok := call["id"].(string); ok {
						id = s
					}
					if s, ok := fn["name"].(string); ok {
						name = s
					}
					if s, ok := fn["arguments"].(string); ok {
						fragment(s, true)
					}
				}
				if s, ok := choice["finish_reason"].(string); ok && s != "" {
					finish = s
					terminal++
				}
			}
		case "responses":
			switch event["type"] {
			case "response.output_item.added":
				item, _ := event["item"].(map[string]any)
				if item["type"] == "function_call" {
					id, _ = item["call_id"].(string)
					name, _ = item["name"].(string)
				}
			case "response.function_call_arguments.delta":
				s, _ := event["delta"].(string)
				fragment(s, true)
			case "response.output_text.delta":
				s, _ := event["delta"].(string)
				fragment(s, false)
			case "response.completed":
				response, _ := event["response"].(map[string]any)
				finish, _ = response["status"].(string)
				m, _ := response["usage"].(map[string]any)
				usage(m, "input_tokens", "output_tokens")
				terminal++
			}
		default:
			switch event["type"] {
			case "message_start":
				message, _ := event["message"].(map[string]any)
				m, _ := message["usage"].(map[string]any)
				usage(m, "input_tokens", "output_tokens")
			case "content_block_start":
				block, _ := event["content_block"].(map[string]any)
				if block["type"] == "tool_use" {
					id, _ = block["id"].(string)
					name, _ = block["name"].(string)
				}
			case "content_block_delta":
				delta, _ := event["delta"].(map[string]any)
				if s, ok := delta["text"].(string); ok {
					fragment(s, false)
				}
				if s, ok := delta["partial_json"].(string); ok {
					fragment(s, true)
				}
			case "message_delta":
				delta, _ := event["delta"].(map[string]any)
				if s, ok := delta["stop_reason"].(string); ok {
					finish = s
				}
				m, _ := event["usage"].(map[string]any)
				usage(m, "input_tokens", "output_tokens")
			case "message_stop":
				terminal++
			}
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if terminal != 1 || deltas == 0 || (ingress == "chat" && done != 1) {
		t.Fatalf("incomplete/duplicate stream terminal=%d done=%d deltas=%d: %s", terminal, done, deltas, raw)
	}
	wantIn, wantOut := float64(2), float64(1)
	if final {
		wantIn, wantOut = 3, 2
	}
	if input != wantIn || output != wantOut {
		t.Fatalf("stream usage input=%v output=%v want %v/%v: %s", input, output, wantIn, wantOut, raw)
	}
	var args map[string]any
	if !final {
		if err := json.Unmarshal([]byte(arguments), &args); err != nil {
			t.Fatalf("invalid streamed arguments: %v: %s", err, raw)
		}
	}
	switch ingress {
	case "chat":
		message := map[string]any{"role": "assistant", "content": text}
		if !final {
			message["tool_calls"] = []any{map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": arguments}}}
		}
		return map[string]any{"choices": []any{map[string]any{"message": message, "finish_reason": finish}}, "usage": map[string]any{"prompt_tokens": input, "completion_tokens": output}}
	case "responses":
		item := map[string]any{"type": "function_call", "call_id": id, "name": name, "arguments": arguments}
		if final {
			item = map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text}}}
		}
		return map[string]any{"status": finish, "output": []any{item}, "usage": map[string]any{"input_tokens": input, "output_tokens": output}}
	default:
		item := map[string]any{"type": "tool_use", "id": id, "name": name, "input": args}
		if final {
			item = map[string]any{"type": "text", "text": text}
		}
		return map[string]any{"stop_reason": finish, "content": []any{item}, "usage": map[string]any{"input_tokens": input, "output_tokens": output}}
	}
}
