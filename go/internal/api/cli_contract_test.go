package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
	"llmgw/internal/router"
)

type cliUpstreamCall struct {
	provider string
	path     string
	model    string
	marker   string
}

func setupCLIContractTest(t *testing.T) (*httptest.Server, func() []cliUpstreamCall) {
	t.Helper()
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	iam.ResetForTests()
	router.ResetSavingsState()
	router.ResetTelemetryState()
	if _, err := iam.Initialize(); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var calls []cliUpstreamCall
	newUpstream := func(provider, model string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/models" {
				writeJSON(w, http.StatusOK, map[string]any{"data": []any{map[string]any{
					"id": model, "supported_endpoints": []string{"/chat/completions", "/responses"},
				}}})
				return
			}
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				http.Error(w, "invalid fixture JSON", http.StatusBadRequest)
				return
			}
			marker, shapeError := validateCLIUpstreamShape(r.URL.Path, payload)
			wireModel, _ := payload["model"].(string)
			mu.Lock()
			calls = append(calls, cliUpstreamCall{provider, r.URL.Path, wireModel, marker})
			mu.Unlock()
			if wireModel != model || shapeError != "" {
				http.Error(w, fmt.Sprintf("fixture contract: model=%q shape=%s", wireModel, shapeError), http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/chat/completions":
				writeFixtureChat(w, model, payload["stream"] == true)
			case "/responses":
				writeFixtureResponse(w, model, payload["stream"] == true)
			default:
				http.NotFound(w, r)
			}
		}))
	}
	upstreamA := newUpstream("fixture-a", "model-a")
	upstreamB := newUpstream("fixture-b", "model-b")
	config.Update(func(s *config.Settings) {
		s.APIKey = "gateway-token"
		s.APIKeys = nil
		s.AllowUnauthenticatedAPI = false
		s.Providers = map[string]*config.ProviderConfig{
			"fixture-a": {Type: "openai_compatible", BaseURL: upstreamA.URL, APIKey: "upstream-secret-do-not-leak"},
			"fixture-b": {Type: "openai_compatible", BaseURL: upstreamB.URL, APIKey: "upstream-secret-do-not-leak"},
		}
		s.Endpoints = map[string]*config.EndpointConfig{
			"coding": {Failover: []config.EndpointMember{{Provider: "fixture-b", Model: "model-b"}}, Ingress: []string{"/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens"}, AllowAdaptation: true},
		}
	})
	providers.ResetProviders()
	for _, provider := range []string{"fixture-a", "fixture-b"} {
		if rows := providers.RefreshCatalog(provider); len(rows) != 1 {
			t.Fatalf("%s catalog=%+v", provider, rows)
		}
	}
	gateway := httptest.NewServer(NewServer(Runtime{}))
	t.Cleanup(func() {
		gateway.Close()
		upstreamA.Close()
		upstreamB.Close()
		iam.ResetForTests()
		router.ResetSavingsState()
		router.ResetTelemetryState()
		providers.ResetProviders()
	})
	return gateway, func() []cliUpstreamCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]cliUpstreamCall(nil), calls...)
	}
}

func validateCLIUpstreamShape(path string, payload map[string]any) (string, string) {
	tools, _ := payload["tools"].([]any)
	if len(tools) != 1 {
		return "", "one tool required"
	}
	tool, _ := tools[0].(map[string]any)
	if path == "/responses" {
		marker, _ := payload["input"].(string)
		parameters, _ := tool["parameters"].(map[string]any)
		if marker == "" || tool["type"] != "function" || tool["name"] != "lookup" || parameters["type"] != "object" {
			return marker, "Responses function tool changed"
		}
		return marker, ""
	}
	if path != "/chat/completions" {
		return "", "unexpected upstream path"
	}
	messages, _ := payload["messages"].([]any)
	if len(messages) != 1 {
		return "", "one Chat message required"
	}
	message, _ := messages[0].(map[string]any)
	marker, _ := message["content"].(string)
	function, _ := tool["function"].(map[string]any)
	parameters, _ := function["parameters"].(map[string]any)
	if marker == "" || message["role"] != "user" || tool["type"] != "function" || function["name"] != "lookup" || parameters["type"] != "object" {
		return marker, "Chat message or function tool changed"
	}
	return marker, ""
}

func writeFixtureChat(w http.ResponseWriter, model string, stream bool) {
	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprintf(w, "data: {\"id\":\"chatcmpl_fixture\",\"object\":\"chat.completion.chunk\",\"model\":%q,\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_fixture\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\\\"fixture\\\"}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl_fixture\",\"object\":\"chat.completion.chunk\",\"model\":%q,\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n", model, model)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": "chatcmpl_fixture", "object": "chat.completion", "model": model,
		"choices": []any{map[string]any{"index": 0, "finish_reason": "tool_calls", "message": map[string]any{
			"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{
				"id": "call_fixture", "type": "function", "function": map[string]any{"name": "lookup", "arguments": `{"q":"fixture"}`},
			}},
		}}},
		"usage": map[string]any{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
	})
}

func writeFixtureResponse(w http.ResponseWriter, model string, stream bool) {
	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprintf(w, "data: {\"type\":\"response.output_item.added\",\"sequence_number\":0,\"output_index\":0,\"item\":{\"id\":\"fc_fixture\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_fixture\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\ndata: {\"type\":\"response.function_call_arguments.done\",\"sequence_number\":1,\"item_id\":\"fc_fixture\",\"output_index\":0,\"arguments\":\"{\\\"q\\\":\\\"fixture\\\"}\"}\n\ndata: {\"type\":\"response.completed\",\"sequence_number\":2,\"response\":{\"id\":\"resp_fixture\",\"object\":\"response\",\"status\":\"completed\",\"model\":%q,\"output\":[]}}\n\n", model)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": "resp_fixture", "object": "response", "status": "completed", "model": model,
		"output": []any{map[string]any{"id": "fc_fixture", "type": "function_call", "status": "completed", "call_id": "call_fixture", "name": "lookup", "arguments": `{"q":"fixture"}`}},
		"usage":  map[string]any{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
	})
}

func cliTool(openAI bool) []any {
	tool := map[string]any{"name": "lookup", "parameters": map[string]any{"type": "object"}}
	if openAI {
		return []any{map[string]any{"type": "function", "function": tool}}
	}
	return []any{map[string]any{"name": "lookup", "input_schema": map[string]any{"type": "object"}}}
}

func TestCLIModelDiscoveryAuthenticationContract(t *testing.T) {
	server, _ := setupCLIContractTest(t)
	for _, tc := range []struct {
		name, apiKey, bearer string
		wantStatus           int
	}{
		{"claude x-api-key", "gateway-token", "", http.StatusOK},
		{"claude bearer", "", "gateway-token", http.StatusOK},
		{"copilot bearer", "", "gateway-token", http.StatusOK},
		{"x-api-key precedes bearer", "wrong", "gateway-token", http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, server.URL+"/v1/models", nil)
			req.Header.Set("x-api-key", tc.apiKey)
			if tc.bearer != "" {
				req.Header.Set("Authorization", "Bearer "+tc.bearer)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("status=%d body=%s", resp.StatusCode, body)
			}
			if tc.wantStatus == http.StatusOK && (!bytes.Contains(body, []byte(`"id":"fixture-a/model-a"`)) || !bytes.Contains(body, []byte(`"id":"coding"`))) {
				t.Fatalf("models=%s", body)
			}
		})
	}
}

func TestCLIRequestRoutingAndShapeContract(t *testing.T) {
	server, readCalls := setupCLIContractTest(t)
	for _, tc := range []struct {
		name, path, model, marker, provider, wirePath, wireModel string
		body                                                     map[string]any
		want                                                     []string
	}{
		{"claude exact", "/v1/messages", "fixture-a/model-a", "claude-exact", "fixture-a", "/chat/completions", "model-a", map[string]any{"max_tokens": 32, "messages": []any{map[string]any{"role": "user", "content": "claude-exact"}}, "tools": cliTool(false)}, []string{`"type":"message"`, `"model":"model-a"`, `"type":"tool_use"`}},
		{"claude endpoint alias", "/messages", "coding", "claude-endpoint", "fixture-b", "/chat/completions", "model-b", map[string]any{"max_tokens": 32, "messages": []any{map[string]any{"role": "user", "content": "claude-endpoint"}}, "tools": cliTool(false)}, []string{`"type":"message"`, `"model":"model-b"`, `"type":"tool_use"`}},
		{"codex exact", "/v1/responses", "fixture-a/model-a", "codex-exact", "fixture-a", "/responses", "model-a", map[string]any{"input": "codex-exact", "tools": []any{map[string]any{"type": "function", "name": "lookup", "parameters": map[string]any{"type": "object"}}}, "client_metadata": map[string]any{"client": "codex"}, "include": []any{"reasoning.encrypted_content"}, "parallel_tool_calls": false, "prompt_cache_key": "codex-cache"}, []string{`"object":"response"`, `"model":"model-a"`, `"type":"function_call"`}},
		{"codex endpoint alias", "/responses", "coding", "codex-endpoint", "fixture-b", "/responses", "model-b", map[string]any{"input": "codex-endpoint", "tools": []any{map[string]any{"type": "function", "name": "lookup", "parameters": map[string]any{"type": "object"}}}}, []string{`"object":"response"`, `"model":"model-b"`, `"type":"function_call"`}},
		{"copilot exact", "/v1/chat/completions", "fixture-a/model-a", "copilot-exact", "fixture-a", "/chat/completions", "model-a", map[string]any{"messages": []any{map[string]any{"role": "user", "content": "copilot-exact"}}, "tools": cliTool(true)}, []string{`"object":"chat.completion"`, `"model":"model-a"`, `"tool_calls"`}},
		{"copilot endpoint alias", "/chat/completions", "coding", "copilot-endpoint", "fixture-b", "/chat/completions", "model-b", map[string]any{"messages": []any{map[string]any{"role": "user", "content": "copilot-endpoint"}}, "tools": cliTool(true)}, []string{`"object":"chat.completion"`, `"model":"model-b"`, `"tool_calls"`}},
		{"copilot responses", "/v1/responses", "coding", "copilot-responses", "fixture-b", "/responses", "model-b", map[string]any{"input": "copilot-responses", "tools": []any{map[string]any{"type": "function", "name": "lookup", "parameters": map[string]any{"type": "object"}}}, "client_metadata": map[string]any{"client": "copilot"}, "include": []any{"reasoning.encrypted_content"}, "prompt_cache_key": "copilot-cache"}, []string{`"object":"response"`, `"model":"model-b"`}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.body["model"] = tc.model
			compatibility := ""
			if tc.path == "/v1/messages" || tc.path == "/messages" {
				compatibility = "allow"
			}
			status, responseBody := cliRequest(t, server.URL+tc.path, tc.body, compatibility)
			if status != http.StatusOK {
				t.Fatalf("status=%d body=%s", status, responseBody)
			}
			for _, want := range tc.want {
				if !bytes.Contains(responseBody, []byte(want)) {
					t.Fatalf("body=%s missing %s", responseBody, want)
				}
			}
			calls := readCalls()
			got := calls[len(calls)-1]
			if got != (cliUpstreamCall{tc.provider, tc.wirePath, tc.wireModel, tc.marker}) {
				t.Fatalf("upstream call=%+v", got)
			}
		})
	}

	status, body := cliRequest(t, server.URL+"/v1/messages/count_tokens", map[string]any{"model": "fixture-a/model-a", "messages": []any{map[string]any{"role": "user", "content": "count this"}}})
	if status != http.StatusOK || !bytes.Contains(body, []byte(`"input_tokens":`)) {
		t.Fatalf("count_tokens status=%d body=%s", status, body)
	}
}

func TestCLIStreamContract(t *testing.T) {
	server, _ := setupCLIContractTest(t)
	for _, tc := range []struct {
		name, path string
		body       map[string]any
		want       []string
	}{
		{"claude", "/v1/messages", map[string]any{"model": "fixture-a/model-a", "messages": []any{map[string]any{"role": "user", "content": "claude-stream"}}, "tools": cliTool(false), "max_tokens": 32, "stream": true}, []string{"event: message_start", `"type":"tool_use"`, "event: message_stop"}},
		{"codex", "/v1/responses", map[string]any{"model": "fixture-a/model-a", "input": "codex-stream", "tools": []any{map[string]any{"type": "function", "name": "lookup", "parameters": map[string]any{"type": "object"}}}, "stream": true}, []string{"event: response.output_item.added", `"type":"function_call"`, "event: response.completed"}},
		{"copilot", "/v1/chat/completions", map[string]any{"model": "fixture-a/model-a", "messages": []any{map[string]any{"role": "user", "content": "copilot-stream"}}, "tools": cliTool(true), "stream": true}, []string{`"model":"model-a"`, `"tool_calls"`, "data: [DONE]"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			compatibility := ""
			if tc.path == "/v1/messages" {
				compatibility = "allow"
			}
			status, body := cliRequest(t, server.URL+tc.path, tc.body, compatibility)
			if status != http.StatusOK {
				t.Fatalf("status=%d body=%s", status, body)
			}
			for _, want := range tc.want {
				if !bytes.Contains(body, []byte(want)) {
					t.Fatalf("body=%s missing %s", body, want)
				}
			}
		})
	}
}

// Each client reads errors in its own vendor's envelope: a Messages client
// Anthropic's, typed by status, without a code and with the request's ID
// beside the error, the others the OpenAI-shaped one.
func TestCLIErrorEnvelopeContract(t *testing.T) {
	server, _ := setupCLIContractTest(t)
	for _, tc := range []struct {
		name, path string
		body       map[string]any
		anthropic  bool
	}{
		{"claude", "/v1/messages", map[string]any{"model": "missing/model", "messages": []any{}, "max_tokens": 1}, true},
		{"copilot", "/v1/chat/completions", map[string]any{"model": "missing/model", "messages": []any{map[string]any{"role": "user", "content": "error"}}}, false},
		{"codex", "/v1/responses", map[string]any{"model": "missing/model", "input": "error"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, raw := cliRequest(t, server.URL+tc.path, tc.body)
			var envelope map[string]any
			if err := json.Unmarshal(raw, &envelope); err != nil {
				t.Fatal(err)
			}
			errorBody, _ := envelope["error"].(map[string]any)
			message, _ := errorBody["message"].(string)
			wantEnvelope := errorBody["type"] == "invalid_request_error" && errorBody["code"] == "404" && len(envelope) == 1
			if tc.anthropic {
				_, hasCode := errorBody["code"]
				requestID, _ := envelope["request_id"].(string)
				wantEnvelope = envelope["type"] == "error" && errorBody["type"] == "not_found_error" && !hasCode && len(envelope) == 3 && requestID != ""
			}
			if status != http.StatusNotFound || !wantEnvelope ||
				!strings.Contains(message, `Model "missing/model"`) || !strings.Contains(message, "GET /v1/models") {
				t.Fatalf("status=%d envelope=%+v", status, envelope)
			}
			for _, unsafe := range []string{"upstream-secret-do-not-leak", "fixture-a", "fixture-b", "contract:"} {
				if strings.Contains(string(raw), unsafe) {
					t.Fatalf("unsafe error detail %q in %s", unsafe, raw)
				}
			}
		})
	}
}

func TestPublicHTTPToolConversations(t *testing.T) {
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
						if r.URL.Path != wirePath || body["model"] != "fixture" {
							t.Errorf("wrong actual target: path=%s model=%v", r.URL.Path, body["model"])
						}
						if stage == 2 {
							assertConversationToolResult(t, wire, body)
						}
						reply := conversationReply(wire, stage == 2)
						if ingress != wire {
							reply = adaptableConversationReply(wire, stage == 2)
						}
						writeJSON(w, http.StatusOK, reply)
					}
					model, permission := wire+"/fixture", "allow"
					if route {
						model, permission = "conversation", ""
					}
					path := map[string]string{"chat": "/v1/chat/completions", "responses": "/v1/responses", "messages": "/v1/messages"}[ingress]
					first := conversationRequest(ingress, model, nil)
					if !route && wire != ingress && !(ingress == "chat" && wire == "responses") {
						status, raw := cliRequest(t, f.server.URL+path, first)
						if status != http.StatusBadRequest || calls.Load() != 0 || !bytes.Contains(raw, []byte("adaptation_required")) {
							t.Fatalf("permission default changed: status=%d calls=%d body=%s", status, calls.Load(), raw)
						}
					}
					status, raw := cliRequest(t, f.server.URL+path, first, permission)
					if ingress == "responses" && wire == "messages" {
						if status != http.StatusBadRequest || calls.Load() != 0 || !bytes.Contains(raw, []byte("request_loss")) || !bytes.Contains(raw, []byte("strict")) {
							t.Fatalf("unsupported strict-tool conversion was not refused: status=%d calls=%d body=%s", status, calls.Load(), raw)
						}
						return
					}
					if status != http.StatusOK {
						t.Fatalf("first turn status=%d body=%s", status, raw)
					}
					var answer map[string]any
					if err := json.Unmarshal(raw, &answer); err != nil {
						t.Fatal(err)
					}
					assertConversationCall(t, ingress, answer)
					if ingress == wire && answer["vendor_request_id"] != "trace" {
						t.Fatalf("native metadata changed: %+v", answer)
					}
					if !route && ingress == "responses" && wire == "responses" {
						item := answer["output"].([]any)[0].(map[string]any)
						if item["id"] != "item_fixture" {
							t.Fatalf("native item ID changed: %+v", item)
						}
						bound := conversationRequest(ingress, model, answer)
						bound["input"].([]any)[1].(map[string]any)["id"] = item["id"]
						boundStatus, boundRaw := cliRequest(t, f.server.URL+path, bound, permission)
						if boundStatus != http.StatusForbidden || calls.Load() != 1 || !bytes.Contains(boundRaw, []byte("private human provider connection")) {
							t.Fatalf("opaque replay binding changed: status=%d calls=%d body=%s", boundStatus, calls.Load(), boundRaw)
						}
					}
					second := conversationRequest(ingress, model, answer)
					status, raw = cliRequest(t, f.server.URL+path, second, permission)
					if status != http.StatusOK {
						t.Fatalf("tool-result turn status=%d body=%s", status, raw)
					}
					if err := json.Unmarshal(raw, &answer); err != nil {
						t.Fatal(err)
					}
					assertConversationFinal(t, ingress, answer)
					if calls.Load() != 2 {
						t.Fatalf("upstream attempts=%d want two", calls.Load())
					}
				})
			}
		}
	}
}

func conversationReply(wire string, final bool) map[string]any {
	usage := map[string]any{"input_tokens": 2, "output_tokens": 1, "total_tokens": 3}
	if final {
		usage = map[string]any{"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
	}
	switch wire {
	case "chat":
		message, finish := map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{"id": "call_fixture", "type": "function", "function": map[string]any{"name": "lookup", "arguments": `{"q":"fixture"}`}}}}, "tool_calls"
		if final {
			message, finish = map[string]any{"role": "assistant", "content": "complete-fixture"}, "stop"
		}
		return map[string]any{"id": "chat_fixture", "object": "chat.completion", "model": "fixture", "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}, "usage": map[string]any{"prompt_tokens": usage["input_tokens"], "completion_tokens": usage["output_tokens"], "total_tokens": usage["total_tokens"]}, "vendor_request_id": "trace"}
	case "messages":
		content, stop := []any{map[string]any{"type": "tool_use", "id": "call_fixture", "name": "lookup", "input": map[string]any{"q": "fixture"}}}, "tool_use"
		if final {
			content, stop = []any{map[string]any{"type": "text", "text": "complete-fixture"}}, "end_turn"
		}
		return map[string]any{"id": "msg_fixture", "type": "message", "role": "assistant", "model": "fixture", "content": content, "stop_reason": stop, "usage": map[string]any{"input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"]}, "vendor_request_id": "trace"}
	default:
		output := []any{map[string]any{"id": "item_fixture", "type": "function_call", "call_id": "call_fixture", "name": "lookup", "arguments": `{"q":"fixture"}`, "status": "completed"}}
		if final {
			output = []any{map[string]any{"id": "message_fixture", "type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "complete-fixture"}}, "status": "completed"}}
		}
		return map[string]any{"id": "resp_fixture", "object": "response", "model": "fixture", "status": "completed", "output": output, "usage": usage, "completed_at": 2, "frequency_penalty": 0, "presence_penalty": 0, "prompt_cache_key": "cache", "prompt_cache_retention": "24h", "safety_identifier": "safe", "vendor_request_id": "trace"}
	}
}

func adaptableConversationReply(wire string, final bool) map[string]any {
	reply := conversationReply(wire, final)
	// Positive conversions use assessed fields; native and refusal tests retain
	// metadata that cannot be represented faithfully on another wire.
	for _, key := range []string{"vendor_request_id", "completed_at", "frequency_penalty", "presence_penalty", "prompt_cache_key", "prompt_cache_retention", "safety_identifier"} {
		delete(reply, key)
	}
	return reply
}

func conversationRequest(ingress, model string, answer map[string]any) map[string]any {
	user := map[string]any{"role": "user", "content": "lookup fixture"}
	body := map[string]any{"model": model}
	switch ingress {
	case "responses":
		body["input"] = "lookup fixture"
		body["tools"] = []any{map[string]any{"type": "function", "name": "lookup", "parameters": map[string]any{"type": "object"}, "strict": false}}
		if answer != nil {
			items := []any{user}
			for _, raw := range answer["output"].([]any) {
				original := raw.(map[string]any)
				item := make(map[string]any, len(original))
				for key, value := range original {
					if key != "id" {
						item[key] = value
					}
				}
				// Public callers replay complete function content using call_id;
				// opaque provider item IDs require the existing private binding.
				items = append(items, item)
			}
			body["input"] = append(items, map[string]any{"type": "function_call_output", "call_id": "call_fixture", "output": "result-fixture"})
		}
	case "messages":
		body["messages"], body["tools"], body["max_tokens"] = []any{user}, cliTool(false), 32
		if answer != nil {
			body["messages"] = []any{user, map[string]any{"role": "assistant", "content": answer["content"]}, map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "call_fixture", "content": "result-fixture"}}}}
		}
	default:
		body["messages"], body["tools"] = []any{user}, cliTool(true)
		if answer != nil {
			body["messages"] = []any{user, answer["choices"].([]any)[0].(map[string]any)["message"], map[string]any{"role": "tool", "tool_call_id": "call_fixture", "content": "result-fixture"}}
		}
	}
	return body
}

func assertConversationCall(t *testing.T, ingress string, answer map[string]any) {
	t.Helper()
	var id, name, arguments string
	switch ingress {
	case "chat":
		choice := answer["choices"].([]any)[0].(map[string]any)
		calls, _ := choice["message"].(map[string]any)["tool_calls"].([]any)
		if len(calls) != 1 || choice["finish_reason"] != "tool_calls" {
			t.Fatalf("bad tool call response: %+v", answer)
		}
		call := calls[0].(map[string]any)
		fn := call["function"].(map[string]any)
		id, _ = call["id"].(string)
		name, _ = fn["name"].(string)
		arguments, _ = fn["arguments"].(string)
	case "responses":
		calls := answer["output"].([]any)
		if len(calls) != 1 || answer["status"] != "completed" {
			t.Fatalf("bad function response: %+v", answer)
		}
		call := calls[0].(map[string]any)
		id, _ = call["call_id"].(string)
		name, _ = call["name"].(string)
		arguments, _ = call["arguments"].(string)
	default:
		calls := answer["content"].([]any)
		if len(calls) != 1 || answer["stop_reason"] != "tool_use" {
			t.Fatalf("bad tool use response: %+v", answer)
		}
		call := calls[0].(map[string]any)
		id, _ = call["id"].(string)
		name, _ = call["name"].(string)
		a, _ := json.Marshal(call["input"])
		arguments = string(a)
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(arguments), &args); err != nil || id != "call_fixture" || name != "lookup" || !reflect.DeepEqual(args, map[string]any{"q": "fixture"}) {
		t.Fatalf("call identity/arguments changed: %+v", answer)
	}
}

func assertConversationToolResult(t *testing.T, wire string, body map[string]any) {
	t.Helper()
	if wire == "responses" {
		items, _ := body["input"].([]any)
		foundCall, foundResult := false, false
		for _, raw := range items {
			item, _ := raw.(map[string]any)
			if item["type"] == "function_call" {
				foundCall = item["call_id"] == "call_fixture" && item["name"] == "lookup" && item["arguments"] == `{"q":"fixture"}`
			}
			if item["type"] == "function_call_output" {
				foundResult = item["call_id"] == "call_fixture" && item["output"] == "result-fixture"
			}
		}
		if !foundCall || !foundResult {
			t.Errorf("Responses history/result changed: %+v", body)
		}
		return
	}
	messages, _ := body["messages"].([]any)
	if len(messages) != 3 {
		t.Errorf("conversation history length changed: %+v", body)
		return
	}
	assistant, _ := messages[1].(map[string]any)
	result, _ := messages[2].(map[string]any)
	if assistant["role"] != "assistant" {
		t.Errorf("assistant history lost: %+v", body)
	}
	if wire == "chat" {
		calls, _ := assistant["tool_calls"].([]any)
		if len(calls) != 1 {
			t.Errorf("assistant call lost: %+v", body)
			return
		}
		call := calls[0].(map[string]any)
		if call["id"] != "call_fixture" || result["role"] != "tool" || result["tool_call_id"] != "call_fixture" || result["content"] != "result-fixture" {
			t.Errorf("Chat result identity changed: %+v", body)
		}
	} else {
		calls, _ := assistant["content"].([]any)
		outputs, _ := result["content"].([]any)
		if len(calls) != 1 || len(outputs) != 1 {
			t.Errorf("Messages call/result lost: %+v", body)
			return
		}
		call, output := calls[0].(map[string]any), outputs[0].(map[string]any)
		if call["type"] != "tool_use" || call["id"] != "call_fixture" || result["role"] != "user" || output["type"] != "tool_result" || output["tool_use_id"] != "call_fixture" || output["content"] != "result-fixture" {
			t.Errorf("Messages result identity changed: %+v", body)
		}
	}
}

func assertConversationFinal(t *testing.T, ingress string, answer map[string]any) {
	t.Helper()
	var text, stop string
	switch ingress {
	case "chat":
		choice := answer["choices"].([]any)[0].(map[string]any)
		text, _ = choice["message"].(map[string]any)["content"].(string)
		stop, _ = choice["finish_reason"].(string)
		if stop != "stop" {
			t.Fatalf("final finish state=%s", stop)
		}
	case "responses":
		item := answer["output"].([]any)[0].(map[string]any)
		text, _ = item["content"].([]any)[0].(map[string]any)["text"].(string)
		if answer["status"] != "completed" {
			t.Fatalf("final status=%v", answer["status"])
		}
	default:
		text, _ = answer["content"].([]any)[0].(map[string]any)["text"].(string)
		if answer["stop_reason"] != "end_turn" {
			t.Fatalf("final stop state=%v", answer["stop_reason"])
		}
	}
	if text != "complete-fixture" {
		t.Fatalf("final content changed: %+v", answer)
	}
	usage, _ := answer["usage"].(map[string]any)
	input, output := "input_tokens", "output_tokens"
	if ingress == "chat" {
		input, output = "prompt_tokens", "completion_tokens"
	}
	if usage[input] != float64(3) || usage[output] != float64(2) {
		t.Fatalf("final usage changed: %+v", answer)
	}
}

func cliRequest(t *testing.T, url string, body map[string]any, compatibility ...string) (int, []byte) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer gateway-token")
	req.Header.Set("Content-Type", "application/json")
	if len(compatibility) > 0 && compatibility[0] != "" {
		req.Header.Set(compatibilityHeader, compatibility[0])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, responseBody
}
