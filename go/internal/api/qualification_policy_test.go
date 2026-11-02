package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
)

func TestResponsesFinalPhaseThroughPublicHTTP(t *testing.T) {
	for _, phase := range []string{"", "final_answer", "commentary", "future_phase"} {
		for _, surface := range []string{"/v1/chat/completions", "/v1/messages", "/v1/responses"} {
			t.Run("phase="+phase+"/"+surface, func(t *testing.T) {
				f := newNativePolicyFixture(t)
				config.Update(func(s *config.Settings) {
					s.APIKey = "gateway-token"
					s.Providers["responses"].ForceApiSupport = true
				})
				if rows := providers.RefreshCatalog("responses"); len(rows) != 1 {
					t.Fatalf("catalog=%+v", rows)
				}
				var calls atomic.Int32
				f.response = func(map[string]any) map[string]any {
					calls.Add(1)
					item := map[string]any{"type": "message", "id": "msg_phase", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "OK", "annotations": []any{}}}}
					if phase != "" {
						item["phase"] = phase
					}
					return map[string]any{
						"id": "resp_phase", "object": "response", "model": "reported-responses", "status": "completed",
						"output": []any{item},
						"usage":  map[string]any{"input_tokens": 2, "output_tokens": 1, "total_tokens": 3},
					}
				}
				body := map[string]any{"model": "responses/fixture", "messages": []any{map[string]any{"role": "user", "content": "Reply with OK only."}}, "max_tokens": 8, "temperature": 0}
				if surface == "/v1/responses" {
					delete(body, "messages")
					delete(body, "max_tokens")
					body["input"], body["max_output_tokens"] = "Reply with OK only.", 8
				}
				status, raw := cliRequest(t, f.server.URL+surface, body, "allow")
				if calls.Load() != 1 {
					t.Fatalf("upstream attempts=%d want one", calls.Load())
				}
				if phase != "" && surface != "/v1/responses" {
					if status != http.StatusBadRequest || !strings.Contains(string(raw), "translation would lose output.0.phase") {
						t.Fatalf("phase loss was not refused: status=%d body=%s", status, raw)
					}
					return
				}
				if status != http.StatusOK {
					t.Fatalf("status=%d body=%s", status, raw)
				}
				var got map[string]any
				if err := json.Unmarshal(raw, &got); err != nil {
					t.Fatal(err)
				}
				switch surface {
				case "/v1/chat/completions":
					choice := got["choices"].([]any)[0].(map[string]any)
					if choice["message"].(map[string]any)["content"] != "OK" || choice["finish_reason"] != "stop" {
						t.Fatalf("answer changed: %s", raw)
					}
				case "/v1/messages":
					if got["content"].([]any)[0].(map[string]any)["text"] != "OK" || got["stop_reason"] != "end_turn" {
						t.Fatalf("answer changed: %s", raw)
					}
				default:
					item := got["output"].([]any)[0].(map[string]any)
					value, present := item["phase"]
					if present != (phase != "") || (phase != "" && value != phase) || got["status"] != "completed" {
						t.Fatalf("native phase changed: %s", raw)
					}
				}
				usage := got["usage"].(map[string]any)
				in, out := "input_tokens", "output_tokens"
				if surface == "/v1/chat/completions" {
					in, out = "prompt_tokens", "completion_tokens"
				}
				if usage[in] != float64(2) || usage[out] != float64(1) {
					t.Fatalf("usage changed: %s", raw)
				}
			})
		}
	}
}

func TestExtensionResponsesNativeAndExplicitChatMapping(t *testing.T) {
	var calls atomic.Int32
	daemon := http.NewServeMux()
	daemon.HandleFunc("GET /extension/v1/github_copilot/models", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"models": []any{map[string]any{"id": "model-a", "supported_apis": []string{"/responses"}}}})
	})
	daemon.HandleFunc("POST /extension/v1/github_copilot/invoke", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["input"] == nil || body["messages"] != nil {
			t.Errorf("daemon did not receive native Responses: %+v", body)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"id": "resp_extension", "object": "response", "model": "model-a", "status": "completed",
			"output": []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "OK"}}}},
			"usage":  map[string]any{"input_tokens": 2, "output_tokens": 1, "total_tokens": 3},
		})
	})
	serveExtensionDaemon(t, daemon)
	setupProviderCredentialAPI(t, t.TempDir())
	providers.InstallForTests(t)
	config.Update(func(s *config.Settings) {
		s.Providers = map[string]*config.ProviderConfig{"copilot": {Type: "github_copilot"}}
		s.Endpoints = map[string]*config.EndpointConfig{}
		s.AnthropicDiscoveryAliases = false
	})
	providers.ResetProviders()
	t.Cleanup(providers.ResetProviders)
	credential, err := iam.PutGatewayProviderCredential("copilot", "github_oauth", "fixture-shared")
	if err != nil {
		t.Fatal(err)
	}
	token, principal := issueProviderTestKey(t, "native-contract", "service:native-contract", "service", credential.ID, true)
	if rows := providers.RefreshCatalogForPrincipal("copilot", callerOf(principal)); len(rows) != 1 || len(rows[0].SupportedSurfaces) != 1 || rows[0].SupportedSurfaces[0] != "/responses" {
		t.Fatalf("catalog native declaration changed: %+v", rows)
	}
	server := httptest.NewServer(NewServer(Runtime{}))
	defer server.Close()
	for _, tc := range []struct {
		name, surface, header string
		want, upstream        int
	}{
		{"native-only", "/v1/chat/completions", "", 400, 0},
		{"explicit-deny", "/v1/chat/completions", "deny", 400, 0},
		{"explicit-mapping", "/v1/chat/completions", "allow", 200, 1},
		{"native-responses", "/v1/responses", "", 200, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{"model": "copilot/model-a", "messages": []any{map[string]any{"role": "user", "content": "Reply with OK only."}}, "max_tokens": 8, "temperature": 0}
			if tc.surface == "/v1/responses" {
				delete(body, "messages")
				delete(body, "max_tokens")
				body["input"], body["max_output_tokens"] = "Reply with OK only.", 8
			}
			request, err := http.NewRequest(http.MethodPost, server.URL+tc.surface, strings.NewReader(jsonStr(body)))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Authorization", "Bearer "+token)
			if tc.header != "" {
				request.Header.Set(compatibilityHeader, tc.header)
			}
			before := calls.Load()
			status, got := doJSONRequest(t, request)
			if status != tc.want || calls.Load()-before != int32(tc.upstream) {
				t.Fatalf("status=%d calls=%d answer=%+v", status, calls.Load()-before, got)
			}
			if tc.want == 400 && !strings.Contains(jsonStr(got), "adaptation_required") {
				t.Fatalf("wrong refusal: %+v", got)
			}
			if tc.want == 200 && !strings.Contains(jsonStr(got), "OK") {
				t.Fatalf("answer lost: %+v", got)
			}
		})
	}
}
