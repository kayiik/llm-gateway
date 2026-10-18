package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"

	core "github.com/kayiik/llmgw-core"
)

type nativePolicyFixture struct {
	server                 *httptest.Server
	google, chat, messages atomic.Int32
	input                  chan map[string]any
	count                  atomic.Int32
}

func newNativePolicyFixture(t *testing.T) *nativePolicyFixture {
	t.Helper()
	fixture := &nativePolicyFixture{input: make(chan map[string]any, 16)}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		decoder := json.NewDecoder(r.Body)
		decoder.UseNumber()
		_ = decoder.Decode(&body)
		stream, _ := body["stream"].(bool)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "generateContent"), strings.Contains(r.URL.Path, "streamGenerateContent"):
			fixture.google.Add(1)
			answer := `{"modelVersion":"reported-google","candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1,"totalTokenCount":3}}`
			if strings.Contains(r.URL.Path, "streamGenerateContent") {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, "data: "+answer+"\n\n")
			} else {
				_, _ = fmt.Fprint(w, answer)
			}
		case r.URL.Path == "/chat/completions":
			fixture.chat.Add(1)
			fixture.input <- body
			if stream {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, "data: {\"id\":\"fixture-chat\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			} else {
				vendor := ""
				if body["provider_number"] != nil {
					vendor = `,"vendor_count":9007199254740993`
				}
				_, _ = fmt.Fprintf(w, `{"id":"fixture-chat","object":"chat.completion","model":"reported-chat"%s,"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`, vendor)
			}
		case r.URL.Path == "/v1/messages":
			fixture.messages.Add(1)
			_, _ = fmt.Fprint(w, `{"id":"fixture-message","type":"message","role":"assistant","model":"reported-messages","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":1}}`)
		case r.URL.Path == "/v1/messages/count_tokens":
			fixture.count.Add(1)
			_, _ = fmt.Fprint(w, `{"input_tokens":5}`)
		case r.URL.Path == "/responses":
			response := map[string]any{"id": "resp_fixture", "object": "response", "model": "reported-responses", "status": "completed", "output": []any{}, "instructions": body["instructions"]}
			if metadata, ok := body["metadata"].(map[string]any); ok && metadata["fixture_instructions"] != nil {
				response["instructions"] = metadata["fixture_instructions"]
			}
			if stream {
				w.Header().Set("Content-Type", "text/event-stream")
				for sequence, kind := range []string{"response.created", "response.completed"} {
					_, _ = fmt.Fprintf(w, "data: %s\n\n", jsonStr(map[string]any{"type": kind, "sequence_number": sequence, "response": response}))
				}
			} else {
				_, _ = fmt.Fprint(w, jsonStr(response))
			}
		case r.URL.Path == "/models":
			_, _ = fmt.Fprint(w, `{"data":[{"id":"fixture","supported_endpoints":["/responses"]}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	state := t.TempDir()
	t.Setenv("LLMGW_STATE_DIR", state)
	t.Setenv("LLMGW_CONFIG", state+"/config.yaml")
	old := *config.Get()
	iam.ResetForTests()
	providers.ResetProviders()
	t.Cleanup(func() {
		iam.ResetForTests()
		providers.ResetProviders()
		config.Update(func(s *config.Settings) { *s = old })
	})
	config.Update(func(s *config.Settings) {
		s.APIKey, s.APIKeys, s.AllowUnauthenticatedAPI, s.SSOEnabled = "gateway-fixture", nil, false, false
		s.GatewayPreamble, s.CredentialEncryptionKey = "", ""
		s.Providers = map[string]*config.ProviderConfig{
			"studio":    {Type: "ai_studio", BaseURL: upstream.URL, APIKey: "fixture-provider", ForceApiSupport: true},
			"chat":      {Type: "openai_compatible", BaseURL: upstream.URL, APIKey: "fixture-provider"},
			"messages":  {Type: "anthropic", BaseURL: upstream.URL, APIKey: "fixture-provider"},
			"responses": {Type: "openai_compatible", RegistryID: "openai", BaseURL: upstream.URL, APIKey: "fixture-provider"},
		}
		s.Endpoints = map[string]*config.EndpointConfig{
			"coding":      {Failover: []config.EndpointMember{{Provider: "studio", Model: "fixture"}, {Provider: "chat", Model: "fixture"}}, Ingress: []string{"/v1/chat/completions"}, AllowAdaptation: true},
			"native-only": {Failover: []config.EndpointMember{{Provider: "studio", Model: "fixture"}, {Provider: "chat", Model: "fixture"}}},
		}
		s.Policies.Defaults = config.ProviderPolicy{RetryMaxAttempts: 1}
		s.Policies.Overrides = map[string]config.ProviderPolicy{}
	})
	fixture.server = httptest.NewServer(NewServer(Runtime{}))
	t.Cleanup(fixture.server.Close)
	return fixture
}

func (f *nativePolicyFixture) call(t *testing.T, path, model, compatibility string, stream bool) (int, string) {
	t.Helper()
	body := map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": "hi"}}, "stream": stream}
	if path == "/v1/messages" {
		body["max_tokens"] = 8
	}
	encoded, _ := json.Marshal(body)
	request, err := http.NewRequest(http.MethodPost, f.server.URL+path, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer gateway-fixture")
	if compatibility != "" {
		request.Header.Set(compatibilityHeader, compatibility)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, string(raw)
}

func TestNativePolicyDirectCallsRequireExplicitCompatibility(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, compatibility := range []string{"", "deny", "allow"} {
			t.Run(fmt.Sprintf("stream=%v/%s", stream, compatibility), func(t *testing.T) {
				fixture := newNativePolicyFixture(t)
				status, body := fixture.call(t, "/v1/chat/completions", "studio/fixture", compatibility, stream)
				if compatibility == "allow" {
					if status != http.StatusOK || fixture.google.Load() != 1 {
						t.Fatalf("compatible call status=%d calls=%d body=%s", status, fixture.google.Load(), body)
					}
				} else if status != http.StatusBadRequest || fixture.google.Load() != 0 {
					t.Fatalf("native-only call status=%d calls=%d body=%s", status, fixture.google.Load(), body)
				}
			})
		}
	}
}

func TestNativePolicyRoutePermissionCannotBeBroadenedByRequest(t *testing.T) {
	for _, tc := range []struct {
		route, header string
		google, chat  int32
	}{
		{"coding", "", 1, 0}, {"coding", "deny", 0, 1}, {"native-only", "allow", 0, 1},
	} {
		t.Run(tc.route+"/"+tc.header, func(t *testing.T) {
			fixture := newNativePolicyFixture(t)
			status, body := fixture.call(t, "/v1/chat/completions", tc.route, tc.header, false)
			if status != http.StatusOK || fixture.google.Load() != tc.google || fixture.chat.Load() != tc.chat {
				t.Fatalf("status=%d google=%d chat=%d body=%s", status, fixture.google.Load(), fixture.chat.Load(), body)
			}
		})
	}
}

func TestNativePolicyMessagesUsesTheActualAPI(t *testing.T) {
	for _, tc := range []struct {
		model, header string
		status        int
	}{
		{"messages/fixture", "", http.StatusOK}, {"chat/fixture", "", http.StatusBadRequest}, {"chat/fixture", "allow", http.StatusOK},
	} {
		t.Run(tc.model+"/"+tc.header, func(t *testing.T) {
			fixture := newNativePolicyFixture(t)
			status, body := fixture.call(t, "/v1/messages", tc.model, tc.header, false)
			if status != tc.status {
				t.Fatalf("status=%d want=%d body=%s", status, tc.status, body)
			}
			if tc.status == http.StatusBadRequest && (fixture.chat.Load() != 0 || fixture.messages.Load() != 0) {
				t.Fatal("unadmitted conversion reached inference")
			}
		})
	}
}

func TestNativePolicyPreservesNativeNumbersAndReportedModel(t *testing.T) {
	fixture := newNativePolicyFixture(t)
	request, err := http.NewRequest(http.MethodPost, fixture.server.URL+"/v1/chat/completions", strings.NewReader(`{"model":"chat/fixture","messages":[{"role":"user","content":"hi"}],"provider_number":9007199254740993}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer gateway-fixture")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var value map[string]any
	decoder := json.NewDecoder(response.Body)
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || value["model"] != "reported-chat" || value["vendor_count"] != json.Number("9007199254740993") {
		t.Fatalf("native response status=%d value=%v", response.StatusCode, value)
	}
	input := <-fixture.input
	if input["provider_number"] != json.Number("9007199254740993") {
		t.Fatalf("native request number changed: %v", input["provider_number"])
	}
}

func TestInferenceRejectsTrailingJSONBeforeAnyCall(t *testing.T) {
	for _, tc := range []struct{ path, body string }{
		{"/v1/chat/completions", `{"model":"chat/fixture","messages":[{"role":"user","content":"hi"}]}`},
		{"/v1/responses", `{"model":"chat/fixture","input":"hi"}`},
		{"/v1/messages", `{"model":"messages/fixture","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`},
	} {
		t.Run(tc.path, func(t *testing.T) {
			fixture := newNativePolicyFixture(t)
			request, err := http.NewRequest(http.MethodPost, fixture.server.URL+tc.path, strings.NewReader(tc.body+" {}"))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Authorization", "Bearer gateway-fixture")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			_, _ = io.Copy(io.Discard, response.Body)
			if response.StatusCode != http.StatusUnprocessableEntity || fixture.google.Load()+fixture.chat.Load()+fixture.messages.Load() != 0 {
				t.Fatalf("trailing body status=%d calls=%d/%d/%d", response.StatusCode, fixture.google.Load(), fixture.chat.Load(), fixture.messages.Load())
			}
		})
	}
}

func TestNativePolicyResponsesStreamDoesNotExposeGatewayPreamble(t *testing.T) {
	fixture := newNativePolicyFixture(t)
	config.Update(func(s *config.Settings) { s.GatewayPreamble = "GATEWAY_ONLY_FIXTURE" })
	request, err := http.NewRequest(http.MethodPost, fixture.server.URL+"/v1/responses", strings.NewReader(`{"model":"responses/fixture","input":"hi","instructions":"public instructions","stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer gateway-fixture")
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	if response.StatusCode != http.StatusOK || strings.Contains(body, "GATEWAY_ONLY_FIXTURE") || !strings.Contains(body, "event: response.completed\n") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	for _, frame := range strings.Split(strings.TrimSpace(body), "\n\n") {
		value, _ := preparedEvent([]byte(frame))
		if value["response"].(map[string]any)["instructions"] != "public instructions" {
			t.Fatalf("public instructions changed: %s", frame)
		}
	}
}

func TestRouteIngressRestrictsTokenCount(t *testing.T) {
	for _, allowed := range []bool{false, true} {
		t.Run(fmt.Sprint(allowed), func(t *testing.T) {
			fixture := newNativePolicyFixture(t)
			config.Update(func(s *config.Settings) {
				ingress := "/v1/chat/completions"
				if allowed {
					ingress = "/v1/messages/count_tokens"
				}
				s.Endpoints["counter"] = &config.EndpointConfig{Ingress: []string{ingress}, Failover: []config.EndpointMember{{Provider: "messages", Model: "fixture"}}}
			})
			status, body := fixture.call(t, "/v1/messages/count_tokens", "counter", "", false)
			if allowed {
				if status != http.StatusOK || fixture.count.Load() != 1 || !strings.Contains(body, `"input_tokens":5`) {
					t.Fatalf("allowed count status=%d calls=%d body=%s", status, fixture.count.Load(), body)
				}
			} else if status != http.StatusBadRequest || fixture.count.Load() != 0 || !strings.Contains(body, "ingress") {
				t.Fatalf("disallowed count status=%d calls=%d body=%s", status, fixture.count.Load(), body)
			}
		})
	}
}

func TestRouteIngressRestrictsOtherOperationResolvers(t *testing.T) {
	newNativePolicyFixture(t)
	for _, operation := range []core.ModelOperation{core.ModelOperationAudioIn, core.ModelOperationAudioOut, core.ModelOperationEmbeddings} {
		_, _, status, message := resolveAudioTarget(nil, "coding", operation)
		if status != http.StatusBadRequest || !strings.Contains(message, "ingress") {
			t.Fatalf("%s status=%d message=%s", operation, status, message)
		}
	}
	for _, operation := range []core.ModelOperation{core.ModelOperationImage, core.ModelOperationVideo} {
		_, _, status, message := resolveMediaTarget(nil, "coding", operation)
		if status != http.StatusBadRequest || !strings.Contains(message, "ingress") {
			t.Fatalf("%s status=%d message=%s", operation, status, message)
		}
	}
}

func TestNativePolicyResponsesToMessagesRejectsUnsupportedSchema(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprint(stream), func(t *testing.T) {
			fixture := newNativePolicyFixture(t)
			body := jsonStr(map[string]any{"model": "messages/fixture", "input": "hi", "stream": stream,
				"text": map[string]any{"format": map[string]any{"type": "json_schema", "name": "answer", "strict": true, "schema": map[string]any{"type": "object"}}}})
			request, err := http.NewRequest(http.MethodPost, fixture.server.URL+"/v1/responses", strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Authorization", "Bearer gateway-fixture")
			request.Header.Set(compatibilityHeader, "allow")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			_, _ = io.Copy(io.Discard, response.Body)
			if response.StatusCode != http.StatusBadRequest || fixture.messages.Load()+fixture.chat.Load()+fixture.google.Load() != 0 {
				t.Fatalf("unsupported schema status=%d calls=%d/%d/%d", response.StatusCode, fixture.messages.Load(), fixture.chat.Load(), fixture.google.Load())
			}
		})
	}
}

func TestPlaygroundPreparedPolicyParity(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, tc := range []struct {
			name, model, header string
			allowed             bool
		}{
			{"direct default", "studio/fixture", "", false},
			{"direct deny", "studio/fixture", "deny", false},
			{"wrong ingress", "messages-only", "allow", false},
			{"route adaptation", "coding", "", true},
		} {
			t.Run(fmt.Sprintf("%s/stream=%v", tc.name, stream), func(t *testing.T) {
				fixture := newNativePolicyFixture(t)
				config.Update(func(s *config.Settings) {
					s.Endpoints["messages-only"] = &config.EndpointConfig{Ingress: []string{"/v1/messages"}, AllowAdaptation: true, Failover: []config.EndpointMember{{Provider: "studio", Model: "fixture"}}}
				})
				owner, err := iam.EnsurePrincipalBySubject("human", "playground-policy-fixture", "", "Fixture Owner")
				if err != nil {
					t.Fatal(err)
				}
				project, err := iam.CreateProject("playground-policy", "Fixture Project")
				if err != nil {
					t.Fatal(err)
				}
				if _, err := iam.SetProjectPolicy(project.ID, iam.KeyPolicy{DailyRequests: 1}); err != nil {
					t.Fatal(err)
				}
				principal := &config.Principal{PrincipalID: owner.ID, PrincipalKind: "human", ProjectID: project.ID, Project: project.Slug, Key: "playground"}
				request := httptest.NewRequest(http.MethodPost, "/admin/api/playground/request", nil)
				if tc.header != "" {
					request.Header.Set(compatibilityHeader, tc.header)
				}
				writer := httptest.NewRecorder()
				payload := map[string]any{"model": tc.model, "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
				executePlaygroundSurface(writer, request, payload, playgroundBody{Model: tc.model, Stream: stream}, principal, project, "admin", core.ModelSurfaceChatCompletions)
				if tc.allowed {
					if writer.Code != http.StatusOK || fixture.google.Load() != 1 {
						t.Fatalf("allowed status=%d calls=%d body=%s", writer.Code, fixture.google.Load(), writer.Body.String())
					}
				} else {
					if writer.Code != http.StatusBadRequest || fixture.google.Load()+fixture.chat.Load() != 0 {
						t.Fatalf("rejected status=%d calls=%d/%d body=%s", writer.Code, fixture.google.Load(), fixture.chat.Load(), writer.Body.String())
					}
					if err := iam.CheckAndConsumeProjectRequest(project.ID, time.Now()); err != nil {
						t.Fatalf("preparation refusal consumed the project quota: %v", err)
					}
				}
			})
		}
	}
}

func TestTransparentResponsesPreservesUpstreamInstructions(t *testing.T) {
	fixture := newNativePolicyFixture(t)
	trustCatalog(t, "responses")
	request, err := http.NewRequest(http.MethodPost, fixture.server.URL+"/v1/responses", strings.NewReader(`{"model":"responses/fixture","input":"hi","instructions":"caller instructions","metadata":{"fixture_instructions":"upstream instructions"}}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer gateway-fixture")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(transportModeHeader, "transparent")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"resp_fixture","instructions":"upstream instructions","model":"reported-responses","object":"response","output":[],"status":"completed"}`
	if response.StatusCode != http.StatusOK || string(raw) != want || response.Header.Get(transportModeHeader) != "transparent" {
		t.Fatalf("status=%d mode=%s body=%s", response.StatusCode, response.Header.Get(transportModeHeader), raw)
	}
}

func TestPlaygroundRejectsRestrictiveTargetSubsetBeforeQuota(t *testing.T) {
	fixture := newNativePolicyFixture(t)
	owner, err := iam.EnsurePrincipalBySubject("human", "playground-binding-fixture", "", "Fixture Owner")
	if err != nil {
		t.Fatal(err)
	}
	project, err := iam.CreateProject("playground-binding", "Fixture Project")
	if err != nil {
		t.Fatal(err)
	}
	principal := &config.Principal{PrincipalID: owner.ID, PrincipalKind: "human", ProjectID: project.ID, Project: project.Slug, Key: "playground"}
	request := httptest.NewRequest(http.MethodPost, "/admin/api/playground/request", nil)
	resolution, err := resolveModel(request.Context(), "coding", principal)
	if err != nil {
		t.Fatal(err)
	}
	settings, generation := config.Snapshot()
	prepared, err := preparePlaygroundRequest(request, principal, map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}}, "coding", core.ModelSurfaceChatCompletions, settings, generation, resolution, resolution.Targets)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iam.SetProjectPolicy(project.ID, iam.KeyPolicy{DailyRequests: 1, AllowedProviders: []string{"chat"}}); err != nil {
		t.Fatal(err)
	}
	status, message := admitPreparedPlayground(principal, "coding", resolution.Category, prepared.Targets())
	if status != http.StatusConflict || fixture.google.Load()+fixture.chat.Load() != 0 {
		t.Fatalf("status=%d message=%s calls=%d/%d", status, message, fixture.google.Load(), fixture.chat.Load())
	}
	if err := iam.CheckAndConsumeProjectRequest(project.ID, time.Now()); err != nil {
		t.Fatalf("withdrawn target admission consumed quota: %v", err)
	}
}
