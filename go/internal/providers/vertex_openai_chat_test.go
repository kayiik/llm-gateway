package providers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	core "github.com/kayiik/llmgw-core"

	"llmgw/internal/config"
)

// vertexTestTransport answers Google requests in memory. The production code
// still performs the signed OAuth exchange and selects its real destination.
type vertexTestTransport func(*http.Request) (*http.Response, error)

func (f vertexTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func vertexTestResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestVertexOpenAIChatPreservesWireAndRefreshesCredentialAtExecution(t *testing.T) {
	rt := &Runtime{}
	p, err := rt.vertexChatProvider(nil, "vertex-fixture", &config.ProviderConfig{
		Type: "vertex_ai", Project: "fixture-project", Location: "us-central1", VertexRequestType: "paygo", VertexOpenAIChat: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	rt.gcpTokens.Now = func() time.Time { return now }
	exchanges := 0
	rt.gcpTokens.HTTPClient = &http.Client{Transport: vertexTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != googleTokenEndpoint || r.Method != "POST" || r.FormValue("assertion") == "" {
			t.Fatalf("unexpected service-account exchange at %v", r.URL)
		}
		exchanges++
		return vertexTestResponse(fmt.Sprintf(`{"access_token":"fixture-%d","expires_in":3600}`, exchanges)), nil
	})}
	const payload = `{"model":"route","max_completion_tokens":120,"response_format":{"type":"json_object"},"messages":[{"role":"assistant","tool_calls":[{"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{}"},"extra_content":{"google":{"thought_signature":"opaque-tool-state"}}}]},{"role":"tool","tool_call_id":"call-1","content":"value"},{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA","detail":"high"}}]}]}`
	const upstreamBody = `{"choices":[{"message":{"content":"done","extra_content":{"google":{"thought_signature":"opaque-output"}}}}]}`
	var want map[string]any
	if err := json.Unmarshal([]byte(payload), &want); err != nil {
		t.Fatal(err)
	}
	want["model"] = "google/fixture-model"
	want["stream"] = false
	p.client.Transport = vertexTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != "us-central1-aiplatform.googleapis.com" ||
			r.URL.Path != "/v1/projects/fixture-project/locations/us-central1/endpoints/openapi/chat/completions" {
			t.Fatalf("unexpected Vertex destination %v", r.URL)
		}
		if r.Header.Get("Authorization") != fmt.Sprintf("Bearer fixture-%d", exchanges) ||
			r.Header.Get("X-Vertex-AI-LLM-Request-Type") != "shared" || r.Header.Get("X-Goog-Api-Key") != "" {
			t.Fatal("unexpected credential or request-type header at Vertex")
		}
		var got map[string]any
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("chat body changed: %#v", got)
		}
		return vertexTestResponse(upstreamBody), nil
	})
	key := &core.Credential{TokenType: core.TokenTypeGCPServiceAccount, Token: serviceAccountFixture(t)}
	ctx := t.Context()
	request := core.Request{Surface: core.ModelSurfaceChatCompletions, Model: "fixture-model", ContentType: core.ContentTypeJSON, Body: []byte(payload), Credential: key}
	for i, wantExchanges := range []int{1, 1, 2} {
		request.Model = []string{"fixture-model", "models/fixture-model", "google/fixture-model"}[i]
		if i == 2 {
			now = now.Add(2 * time.Hour)
		}
		before := exchanges
		call, err := p.PrepareCall(ctx, request, core.CallPreparationOptions{Mode: core.CallModeInvoke})
		if err != nil {
			t.Fatal(err)
		}
		if d := call.Description(); d.Model != request.Model || d.Deployment != "vertex_openai_chat" || d.WirePreserved != core.SupportSupported || exchanges != before {
			t.Fatalf("unexpected preparation: %+v, exchanges %d (was %d)", d, exchanges, before)
		}
		answer, err := call.Invoke(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		if exchanges != wantExchanges || !strings.Contains(string(answer.Body), "opaque-output") {
			t.Fatalf("call %d exchanges=%d, expected %d and preserved response", i+1, exchanges, wantExchanges)
		}
	}
}

func TestVertexOpenAIChatValidatesSelectedAccountAndDestination(t *testing.T) {
	rt := &Runtime{}
	for _, cfg := range []*config.ProviderConfig{
		{Type: "ai_studio"},
		{Type: "vertex_ai", Location: "outside.example/"},
		{Type: "vertex_ai", BaseURL: "https://proxy.example/v1"},
	} {
		if _, err := rt.vertexChatProvider(nil, "fixture", cfg); err == nil {
			t.Fatalf("accepted incompatible settings %+v", cfg)
		}
	}
	p, err := rt.vertexChatProvider(nil, "fixture", &config.ProviderConfig{Type: "vertex_ai", Project: "other-project"})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []*core.Credential{nil, {TokenType: core.TokenTypeAPIKey, Token: "fixture"},
		{TokenType: core.TokenTypeGCPServiceAccount, Token: serviceAccountFixture(t)}} {
		if _, err := p.account(key); err == nil {
			t.Fatal("accepted a missing, incompatible or cross-project credential")
		}
	}
	if err := p.client.CheckRedirect(&http.Request{}, nil); err != http.ErrUseLastResponse {
		t.Fatal("an inference redirect could forward a minted access token")
	}
	p.project = "fixture-project"
	foreignEndpoint := strings.Replace(serviceAccountFixture(t), googleTokenEndpoint, "https://unexpected.invalid/token", 1)
	if _, err := p.account(&core.Credential{TokenType: core.TokenTypeGCPServiceAccount, Token: foreignEndpoint}); err == nil {
		t.Fatal("accepted a stored service account with a non-Google OAuth endpoint")
	}
}

func TestVertexOpenAIChatFollowsInstanceAndSelectedCredential(t *testing.T) {
	settings := &config.Settings{Providers: map[string]*config.ProviderConfig{
		"compat": {Type: "vertex_ai", Project: "fixture-project", VertexOpenAIChat: true},
		"stock":  {Type: "vertex_ai", Project: "fixture-project"},
	}}
	google := (&Runtime{}).googleCoreVertical()
	sa := &core.Credential{TokenType: core.TokenTypeGCPServiceAccount, Token: serviceAccountFixture(t)}
	apiKey := &core.Credential{TokenType: core.TokenTypeAPIKey, Token: "fixture"}
	r := core.Request{
		Surface: core.ModelSurfaceChatCompletions, Model: "fixture-model", ContentType: core.ContentTypeJSON,
		Body:   []byte(`{"model":"compat","messages":[{"role":"user","content":"fixture"}]}`),
		Header: http.Header{"X-LLMGW-Project-Id": {"project-one"}, "X-LLMGW-Compatibility": {"allow"}},
	}
	for _, tc := range []struct {
		name, instance string
		caller         core.Caller
		credential     *core.Credential
		compat         bool
	}{
		{"first project", "compat", core.Caller{Kind: core.CallerService, ID: "service-one", ProjectID: "project-one"}, sa, true},
		{"second project", "compat", core.Caller{Kind: core.CallerService, ID: "service-two", ProjectID: "project-two"}, sa, true},
		{"human", "compat", core.Caller{Kind: core.CallerHuman, ID: "person", ProjectID: "project-two"}, sa, true},
		{"stock instance", "stock", core.Caller{Kind: core.CallerService, ID: "service-one", ProjectID: "project-one"}, sa, false},
		{"private API key", "compat", core.Caller{Kind: core.CallerHuman, ID: "person", ProjectID: "project-one"}, apiKey, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := google.provider(settings, tc.instance)
			if err != nil {
				t.Fatal(err)
			}
			ctx := withCoreOperation(t.Context(), googleCoreType, tc.caller)
			r.Credential = tc.credential
			call, err := p.(core.CallPreparer).PrepareCall(ctx, r, core.CallPreparationOptions{Mode: core.CallModeInvoke, AllowAdaptation: true})
			if err != nil {
				t.Fatal(err)
			}
			if d := call.Description(); (d.Deployment == "vertex_openai_chat") != tc.compat {
				t.Fatalf("wrong deployment %q for authenticated caller", d.Deployment)
			}
		})
	}
}
