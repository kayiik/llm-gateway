package providers

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/config"
)

func preparedBridgeRuntime(t *testing.T, providers map[string]*config.ProviderConfig, attempts int) *Runtime {
	t.Helper()
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	previous := config.Get()
	t.Cleanup(func() { config.Update(func(settings *config.Settings) { *settings = *previous }) })
	config.Update(func(settings *config.Settings) {
		settings.Providers = providers
		settings.Policies.Defaults = config.ProviderPolicy{RetryMaxAttempts: attempts}
	})
	store := core.NewMemoryCredentialStore()
	return newRuntime(func(bool) (core.CredentialStore, error) { return store, nil })
}

func preparedBridgeRequest() core.Request {
	return core.Request{Surface: core.ModelSurfaceChatCompletions, Model: "fixture", Body: []byte(`{"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}`), ContentType: core.ContentTypeJSON}
}

func TestPreparedBridgeGoogleNativePolicyAndGenerationFence(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`)
	}))
	defer server.Close()
	rt := preparedBridgeRuntime(t, map[string]*config.ProviderConfig{"studio": {Type: "ai_studio", BaseURL: server.URL}}, 1)
	call, err := rt.PrepareCall(t.Context(), "studio", core.LocalCaller(), preparedBridgeRequest(), core.CallPreparationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 {
		t.Fatal("preparation sent inference")
	}
	if _, err := call.Invoke(t.Context(), core.CallPolicy{}); UpstreamStatus(err) != 400 {
		t.Fatalf("native-only Google status=%d err=%v", UpstreamStatus(err), err)
	}
	if _, err := call.Invoke(t.Context(), core.CallPolicy{AllowAdaptation: true}); UpstreamStatus(err) != 400 {
		t.Fatalf("broadened permission status=%d err=%v", UpstreamStatus(err), err)
	}
	if calls.Load() != 0 {
		t.Fatal("native refusal performed inference")
	}
	allowed, err := rt.PrepareCall(t.Context(), "studio", core.LocalCaller(), preparedBridgeRequest(), core.CallPreparationOptions{AllowAdaptation: true})
	if err != nil {
		t.Fatal(err)
	}
	response, err := allowed.Invoke(t.Context(), core.CallPolicy{AllowAdaptation: true})
	if err != nil || !strings.Contains(string(response.Body), "ok") {
		t.Fatalf("allowed request=%s err=%v", response.Body, err)
	}
	stale, err := rt.PrepareCall(t.Context(), "studio", core.LocalCaller(), preparedBridgeRequest(), core.CallPreparationOptions{AllowAdaptation: true})
	if err != nil {
		t.Fatal(err)
	}
	config.Update(func(settings *config.Settings) { settings.Providers["studio"].Disabled = true })
	if _, err := stale.Invoke(t.Context(), core.CallPolicy{AllowAdaptation: true}); UpstreamStatus(err) != 409 || !errors.Is(err, core.ErrPreparedCallStale) {
		t.Fatalf("stale status=%d err=%v", UpstreamStatus(err), err)
	}
	if calls.Load() != 1 {
		t.Fatalf("stale call sent inference: %d", calls.Load())
	}
}

func TestPreparedBridgeRetriesReusableLowLevelCallNotConsumedHandle(t *testing.T) {
	var calls atomic.Int32
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(body))
		if calls.Add(1) < 3 {
			w.WriteHeader(503)
			return
		}
		_, _ = io.WriteString(w, `{"id":"c1","choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer server.Close()
	rt := preparedBridgeRuntime(t, map[string]*config.ProviderConfig{"compatible": {Type: "openai_compatible", BaseURL: server.URL}}, 3)
	call, err := rt.PrepareCall(t.Context(), "compatible", core.LocalCaller(), preparedBridgeRequest(), core.CallPreparationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := call.Invoke(t.Context(), core.CallPolicy{}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 {
		t.Fatalf("attempts=%d", calls.Load())
	}
	for _, body := range bodies {
		if body != bodies[0] {
			t.Fatal("low-level retry changed payload")
		}
	}
	if _, err := call.Invoke(t.Context(), core.CallPolicy{}); UpstreamStatus(err) != 409 || !errors.Is(err, core.ErrPreparedCallConsumed) {
		t.Fatalf("runtime handle reused: %v", err)
	}
}

func TestPreparedBridgeEchoIsReviewedNativeAndLegacyStillWorks(t *testing.T) {
	rt := preparedBridgeRuntime(t, map[string]*config.ProviderConfig{"echo": {Type: "echo"}}, 1)
	call, err := rt.PrepareCall(t.Context(), "echo", core.LocalCaller(), preparedBridgeRequest(), core.CallPreparationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if d := call.Description(); d.UpstreamAPI != core.UpstreamAPIChatCompletions || d.Deployment != "internal_echo" {
		t.Fatalf("echo actual contract=%+v", d)
	}
	response, err := call.Invoke(t.Context(), core.CallPolicy{})
	if err != nil || !strings.Contains(string(response.Body), "echo:hello") {
		t.Fatalf("native echo=%s err=%v", response.Body, err)
	}
	legacy, err := rt.GetProviderForPrincipal("echo", core.LocalCaller())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Complete("fixture", []Message{{"role": "user", "content": "hello"}}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestPreparedBridgeBindsCallerCatalogBeforeSelectingNativeSurface(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/responses" {
			t.Errorf("selected wrong endpoint %s", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"id":"r1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}`)
	}))
	defer server.Close()
	rt := preparedBridgeRuntime(t, map[string]*config.ProviderConfig{"compatible": {Type: "openai_compatible", BaseURL: server.URL}}, 1)
	owner := core.Caller{ID: "owner", Kind: core.CallerHuman}
	capabilities := &core.ModelCapabilities{SchemaVersion: core.ModelCapabilitiesSchemaVersion, Surfaces: core.ModelSurfaceCapabilities{ChatCompletions: core.SupportUnsupported, Responses: core.SupportSupported}, Provenance: core.ModelCapabilityProvenance{Source: core.ModelCapabilitySourceOperatorOverride}}
	rt.catalogs.store(catalogCacheKey("compatible", owner), []ModelInfo{{ID: "fixture", SupportedSurfaces: []string{"/responses"}, TypedCapabilities: capabilities}})
	request := core.Request{Surface: core.ModelSurfaceResponses, Model: "fixture", ContentType: core.ContentTypeJSON, Body: []byte(`{"input":"hello"}`)}
	call, err := rt.PrepareCall(t.Context(), "compatible", owner, request, core.CallPreparationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if d := call.Description(); d.UpstreamAPI != core.UpstreamAPIResponses || len(d.Conversions) != 0 {
		t.Fatalf("caller native surface hidden: %+v", d)
	}
	if _, err := call.Invoke(t.Context(), core.CallPolicy{}); err != nil {
		t.Fatal(err)
	}
	chat, err := rt.PrepareCall(t.Context(), "compatible", owner, preparedBridgeRequest(), core.CallPreparationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := chat.Invoke(t.Context(), core.CallPolicy{}); UpstreamStatus(err) != 400 {
		t.Fatalf("typed negative capability disappeared: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("wrong caller/capability caused inference: %d", calls.Load())
	}
}

func TestPreparedDecorationKeepsLegacyWireAndNativeTokenCount(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages/count_tokens" {
			t.Errorf("unexpected operation %s", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"input_tokens":12}`)
	}))
	defer server.Close()
	rt := preparedBridgeRuntime(t, map[string]*config.ProviderConfig{"messages": {Type: "anthropic", BaseURL: server.URL}}, 1)
	provider, err := rt.coreProvider(config.Get(), "messages")
	if err != nil {
		t.Fatal(err)
	}
	if !core.PreservesWire(provider, "fixture", core.ModelSurfaceMessages) || !core.PreservesWireFor(provider, nil, "fixture", core.ModelSurfaceMessages) {
		t.Fatal("preparation-only decorator erased wire declaration")
	}
	count, err := core.CountTokens(t.Context(), provider, core.TokenCountRequest{Request: core.Request{Surface: core.ModelSurfaceMessages, Model: "fixture", ContentType: core.ContentTypeJSON, Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}})
	if err != nil || count.InputTokens != 12 {
		t.Fatalf("native count changed: %+v %v", count, err)
	}
}

func TestPreparedBridgeRetainsRefusalStatusesAndHealthyStaleClassification(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(403)
		_, _ = io.WriteString(w, `{"error":{"message":"permission denied"}}`)
	}))
	defer server.Close()
	rt := preparedBridgeRuntime(t, map[string]*config.ProviderConfig{"compatible": {Type: "openai_compatible", BaseURL: server.URL}}, 1)
	call, err := rt.PrepareCall(t.Context(), "compatible", core.LocalCaller(), preparedBridgeRequest(), core.CallPreparationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = call.Invoke(t.Context(), core.CallPolicy{})
	if UpstreamStatus(err) != 403 || InvocationFailoverEligible(err) || InvocationCircuitFailure(err) {
		t.Fatalf("refusal changed: %v", err)
	}
	stale := preparedFailure(core.ErrPreparedCallStale, true)
	if UpstreamStatus(stale) != 409 || !errors.Is(stale, core.ErrPreparedCallStale) || InvocationCircuitFailure(stale) || InvocationRetryable(stale) {
		t.Fatalf("stale became health failure: %v", stale)
	}
}
