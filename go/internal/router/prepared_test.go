package router

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
)

func preparedRouterFixture(t *testing.T, configured map[string]*config.ProviderConfig) *Runtime {
	t.Helper()
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	iam.ResetForTests()
	t.Cleanup(iam.ResetForTests)
	before := config.Get()
	t.Cleanup(func() { config.Update(func(settings *config.Settings) { *settings = *before }) })
	config.Update(func(settings *config.Settings) {
		settings.Providers = configured
		settings.Policies.Defaults = config.ProviderPolicy{RetryMaxAttempts: 1}
		settings.Policies.Overrides = map[string]config.ProviderPolicy{}
	})
	rt := NewRuntime(providers.NewRuntime())
	t.Cleanup(rt.ResetTelemetryState)
	return rt
}

func preparedRouterRequest() core.Request {
	return core.Request{Surface: core.ModelSurfaceChatCompletions, Model: "route", ContentType: core.ContentTypeJSON, Body: []byte(`{"messages":[{"role":"user","content":"hello"}]}`)}
}

func TestPreparedRouterPrunesOnlyUnadmittedTargetsAndKeepsNativeBytes(t *testing.T) {
	var google, chat atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "generateContent") {
			google.Add(1)
			_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"unexpected"}]}}]}`)
			return
		}
		chat.Add(1)
		_, _ = io.WriteString(w, `{"id":"c1","model":"reported-model","vendor_count":9007199254740993,"choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer server.Close()
	rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{"google": {Type: "ai_studio", BaseURL: server.URL}, "chat": {Type: "openai_compatible", BaseURL: server.URL}})
	prepared, err := rt.PrepareRequest(t.Context(), []Target{{Provider: "google", Model: "m"}, {Provider: "chat", Model: "m"}}, core.LocalCaller(), preparedRouterRequest(), PreparedOptions{Generation: config.Generation()})
	if err != nil {
		t.Fatal(err)
	}
	if google.Load() != 0 || chat.Load() != 0 {
		t.Fatal("preflight called inference")
	}
	targets := prepared.Targets()
	if len(targets) != 1 || targets[0].Provider != "chat" {
		t.Fatalf("eligible targets=%+v", targets)
	}
	targets[0].Provider = "google"
	descriptions := prepared.Descriptions()
	descriptions[0].UpstreamAPI = core.UpstreamAPIGoogleGenerateContent
	response, served, traces, err := prepared.Invoke(t.Context(), "route")
	if err != nil || served == nil || served.Provider != "chat" {
		t.Fatalf("serve=%v err=%v", served, err)
	}
	if !strings.Contains(string(response.Body), `"vendor_count":9007199254740993`) || !strings.Contains(string(response.Body), `"model":"reported-model"`) {
		t.Fatalf("native envelope rebuilt: %s", response.Body)
	}
	if google.Load() != 0 || chat.Load() != 1 || len(traces) != 1 {
		t.Fatalf("google=%d chat=%d traces=%v", google.Load(), chat.Load(), traces)
	}
}

func TestPreparedRouterFallsBackOnlyBetweenAdmittedTargets(t *testing.T) {
	var bad, good atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/bad/") {
			bad.Add(1)
			w.WriteHeader(503)
			return
		}
		good.Add(1)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer server.Close()
	rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{"bad": {Type: "openai_compatible", BaseURL: server.URL + "/bad"}, "good": {Type: "openai_compatible", BaseURL: server.URL + "/good"}})
	prepared, err := rt.PrepareRequest(t.Context(), []Target{{Provider: "bad", Model: "m"}, {Provider: "good", Model: "m"}}, core.LocalCaller(), preparedRouterRequest(), PreparedOptions{Generation: config.Generation()})
	if err != nil {
		t.Fatal(err)
	}
	_, served, traces, err := prepared.Invoke(t.Context(), "route")
	if err != nil || served == nil || served.Provider != "good" {
		t.Fatalf("serve=%v err=%v", served, err)
	}
	if bad.Load() != 1 || good.Load() != 1 || len(traces) != 2 || traces[0].Status != "failed" || traces[1].Status != "served" {
		t.Fatalf("bad=%d good=%d traces=%v", bad.Load(), good.Load(), traces)
	}
}

func TestPreparedRouterDoesNotRepairResponseFidelityWithAnotherInference(t *testing.T) {
	var google, chat atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "generateContent") {
			google.Add(1)
			_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"answer","thoughtSignature":"opaque-fixture"}]}}]}`)
			return
		}
		chat.Add(1)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"repair"}}]}`)
	}))
	defer server.Close()
	rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{"google": {Type: "ai_studio", BaseURL: server.URL}, "chat": {Type: "openai_compatible", BaseURL: server.URL}})
	prepared, err := rt.PrepareRequest(t.Context(), []Target{{Provider: "google", Model: "m"}, {Provider: "chat", Model: "m"}}, core.LocalCaller(), preparedRouterRequest(), PreparedOptions{Generation: config.Generation(), Preparation: core.CallPreparationOptions{AllowAdaptation: true}, Policy: core.CallPolicy{AllowAdaptation: true}})
	if err != nil {
		t.Fatal(err)
	}
	response, served, traces, err := prepared.Invoke(t.Context(), "route")
	var loss *core.LossPolicyError
	if providers.UpstreamStatus(err) != 400 || !errors.As(err, &loss) || served != nil || len(response.Losses) == 0 {
		t.Fatalf("response loss discarded: %s served=%v err=%v losses=%v", response.Body, served, err, response.Losses)
	}
	if google.Load() != 1 || chat.Load() != 0 || len(traces) != 1 {
		t.Fatalf("paid repair happened google=%d chat=%d traces=%v", google.Load(), chat.Load(), traces)
	}
}

func TestPreparedRouterBudgetDoesNotCutInflightAnswerOrStartNextTarget(t *testing.T) {
	var bad, good atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/bad/") {
			bad.Add(1)
			time.Sleep(60 * time.Millisecond)
			w.WriteHeader(503)
			return
		}
		good.Add(1)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"late"}}]}`)
	}))
	defer server.Close()
	rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{"bad": {Type: "openai_compatible", BaseURL: server.URL + "/bad"}, "good": {Type: "openai_compatible", BaseURL: server.URL + "/good"}})
	ctx := WithFallbackOptions(t.Context(), 20*time.Millisecond, "")
	prepared, err := rt.PrepareRequest(ctx, []Target{{Provider: "bad", Model: "m"}, {Provider: "good", Model: "m"}}, core.LocalCaller(), preparedRouterRequest(), PreparedOptions{Generation: config.Generation()})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, _, _, err = prepared.Invoke(ctx, "route")
	if providers.UpstreamStatus(err) != 504 || bad.Load() != 1 || good.Load() != 0 || time.Since(start) < 50*time.Millisecond {
		t.Fatalf("budget changed semantics err=%v bad=%d good=%d elapsed=%v", err, bad.Load(), good.Load(), time.Since(start))
	}
}

func TestPreparedRouterOpenStreamOutlivesBudgetAndNeverFailsOver(t *testing.T) {
	var first, second atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/second/") {
			second.Add(1)
			return
		}
		first.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"early\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{"first": {Type: "openai_compatible", BaseURL: server.URL + "/first"}, "second": {Type: "openai_compatible", BaseURL: server.URL + "/second"}})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ctx = WithFallbackOptions(ctx, 30*time.Millisecond, "")
	prepared, err := rt.PrepareRequest(ctx, []Target{{Provider: "first", Model: "m"}, {Provider: "second", Model: "m"}}, core.LocalCaller(), preparedRouterRequest(), PreparedOptions{Generation: config.Generation(), Preparation: core.CallPreparationOptions{Mode: core.CallModeStream}})
	if err != nil {
		t.Fatal(err)
	}
	stream, served, _, err := prepared.Stream(ctx, "route")
	if err != nil || served == nil {
		t.Fatalf("open failed: %v", err)
	}
	defer stream.Close()
	time.Sleep(60 * time.Millisecond)
	if frame, err := stream.Next(); err != nil || !strings.Contains(string(frame), "early") {
		t.Fatalf("open budget cut stream: %s %v", frame, err)
	}
	cancel()
	if _, err := stream.Next(); err == nil || err == io.EOF {
		t.Fatalf("request cancellation lost: %v", err)
	}
	if first.Load() != 1 || second.Load() != 0 {
		t.Fatalf("stream replay/fallback first=%d second=%d", first.Load(), second.Load())
	}
}

func TestPreparedRouterPreservesRetryAfterAcrossRealProviderFailure(t *testing.T) {
	for _, status := range []int{429, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.Header().Set("Retry-After", "7")
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"error":{"message":"temporarily unavailable"}}`)
			}))
			defer server.Close()
			rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{"fixture": {Type: "openai_compatible", BaseURL: server.URL}})
			prepared, err := rt.PrepareRequest(t.Context(), []Target{{Provider: "fixture", Model: "m"}}, core.LocalCaller(), preparedRouterRequest(), PreparedOptions{Generation: config.Generation()})
			if err != nil {
				t.Fatal(err)
			}
			_, _, _, err = prepared.Invoke(t.Context(), "route")
			if providers.UpstreamStatus(err) != status || providers.InvocationRetryAfter(err) != "7" || calls.Load() != 1 {
				t.Fatalf("status=%d retry-after=%q calls=%d err=%v", providers.UpstreamStatus(err), providers.InvocationRetryAfter(err), calls.Load(), err)
			}
		})
	}
}

func TestPreparedRouterConfigurationFailureIsOperationalNotCompatibility(t *testing.T) {
	rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{"broken": {Type: "invalid-fixture-type"}})
	_, err := rt.PrepareRequest(t.Context(), []Target{{Provider: "broken", Model: "m"}}, core.LocalCaller(), preparedRouterRequest(), PreparedOptions{Generation: config.Generation()})
	var configuration *providers.ConfigError
	if providers.UpstreamStatus(err) != 500 || !errors.As(err, &configuration) || providers.InvocationRetryable(err) || providers.InvocationCircuitFailure(err) {
		t.Fatalf("configuration misclassified status=%d err=%v", providers.UpstreamStatus(err), err)
	}
}

func TestPreparedRouterTraceSinkAndReturnedTraceUseServedContract(t *testing.T) {
	for _, mode := range []core.CallMode{core.CallModeInvoke, core.CallModeStream} {
		t.Run(string(mode), func(t *testing.T) {
			rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{"echo": {Type: "echo"}})
			ctx, sink := WithAttemptTrace(t.Context())
			prepared, err := rt.PrepareRequest(ctx, []Target{{Provider: "echo", Model: "echo-default"}}, core.LocalCaller(), preparedRouterRequest(), PreparedOptions{Generation: config.Generation(), Preparation: core.CallPreparationOptions{Mode: mode}})
			if err != nil {
				t.Fatal(err)
			}
			var traces []AttemptTrace
			if mode == core.CallModeStream {
				var stream core.StreamIter
				stream, _, traces, err = prepared.Stream(ctx, "route")
				if stream != nil {
					_ = stream.Close()
				}
			} else {
				_, _, traces, err = prepared.Invoke(ctx, "route")
			}
			if err != nil || len(traces) != 1 || traces[0].Status != "served" || !reflect.DeepEqual(traces, sink.Attempts()) {
				t.Fatalf("trace contract err=%v returned=%v sink=%v", err, traces, sink.Attempts())
			}
		})
	}
}

func TestPreparedRouterBindsGenerationAndRequestGovernance(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	iam.ResetForTests()
	t.Cleanup(iam.ResetForTests)
	previous := config.Get()
	t.Cleanup(func() { config.Update(func(settings *config.Settings) { *settings = *previous }) })
	config.Update(func(settings *config.Settings) {
		settings.Providers = map[string]*config.ProviderConfig{"echo": {Type: "echo"}}
		settings.Policies.Defaults = config.ProviderPolicy{RetryMaxAttempts: 1}
	})
	rt := NewRuntime(providers.NewRuntime())
	ctx := WithGovernance(t.Context(), Governance{Project: "project", Key: "first", AllowedProviders: []string{"echo"}})
	request := core.Request{Surface: core.ModelSurfaceChatCompletions, Model: "route", Body: []byte(`{"messages":[{"role":"user","content":"hello"}]}`), ContentType: core.ContentTypeJSON}
	options := PreparedOptions{Generation: config.Generation()}
	prepared, err := rt.PrepareRequest(ctx, []Target{{Provider: "echo", Model: "echo-small"}}, core.LocalCaller(), request, options)
	if err != nil {
		t.Fatal(err)
	}
	other := WithGovernance(t.Context(), Governance{Project: "project", Key: "second", AllowedProviders: []string{"different"}})
	if _, _, _, err := prepared.Invoke(other, "route"); providers.UpstreamStatus(err) != 409 {
		t.Fatalf("other key reused admission: %v", err)
	}
	response, served, _, err := prepared.Invoke(ctx, "route")
	if err != nil || served == nil || !strings.Contains(string(response.Body), "echo:hello") {
		t.Fatalf("response=%s target=%v err=%v", response.Body, served, err)
	}
	if _, _, _, err := prepared.Invoke(ctx, "route"); !errors.Is(err, core.ErrPreparedCallConsumed) {
		t.Fatalf("logical request reused: %v", err)
	}
	stale, err := rt.PrepareRequest(ctx, []Target{{Provider: "echo", Model: "echo-small"}}, core.LocalCaller(), request, PreparedOptions{Generation: config.Generation()})
	if err != nil {
		t.Fatal(err)
	}
	config.Update(func(settings *config.Settings) { settings.Providers["echo"].Disabled = true })
	if _, _, _, err := stale.Invoke(ctx, "route"); providers.UpstreamStatus(err) != 409 {
		t.Fatalf("changed generation reused: %v", err)
	}
}

func TestPreparedCapabilityFilterKeepsNativeTextFormats(t *testing.T) {
	capabilities := &core.ModelCapabilities{SchemaVersion: core.ModelCapabilitiesSchemaVersion, StructuredOutput: core.SupportUnsupported}
	for _, surface := range []core.ModelSurface{core.ModelSurfaceChatCompletions, core.ModelSurfaceResponses} {
		for _, kind := range []string{"text", "json_object", "json_schema"} {
			payload := map[string]any{"response_format": map[string]any{"type": kind}}
			if surface == core.ModelSurfaceResponses {
				payload = map[string]any{"text": map[string]any{"format": map[string]any{"type": kind}}}
			}
			d := core.CallDescription{Ingress: surface, UpstreamAPI: core.UpstreamAPI(surface)}
			if got := preparedModelCapabilities(capabilities, d, payload, time.Now()); got != (kind == "text") {
				t.Fatalf("surface=%s format=%s eligible=%t", surface, kind, got)
			}
		}
	}
}

func TestPreparedCapabilityFilterIgnoresExpiredDynamicNegatives(t *testing.T) {
	now := time.Unix(200, 0)
	past, future := now.Add(-time.Second), now.Add(time.Second)
	for _, feature := range []string{"tools", "image"} {
		capabilities := &core.ModelCapabilities{SchemaVersion: core.ModelCapabilitiesSchemaVersion, Provenance: core.ModelCapabilityProvenance{Source: core.ModelCapabilitySourceUpstreamReported}, Freshness: core.ModelCapabilityFreshness{ExpiresAt: &past}}
		d := core.CallDescription{Ingress: core.ModelSurfaceChatCompletions, UpstreamAPI: core.UpstreamAPIChatCompletions}
		payload := map[string]any{}
		if feature == "tools" {
			capabilities.Tools = core.SupportUnsupported
			d.Requirements.Tools = true
		} else {
			capabilities.Inputs.Image = core.SupportUnsupported
			if err := json.Unmarshal([]byte(`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:,"}}]}]}`), &payload); err != nil {
				t.Fatal(err)
			}
		}
		if !preparedModelCapabilities(capabilities, d, payload, now) {
			t.Fatalf("expired dynamic %s denial remained authoritative", feature)
		}
		capabilities.Freshness.ExpiresAt = &future
		if preparedModelCapabilities(capabilities, d, payload, now) {
			t.Fatalf("fresh %s denial ignored", feature)
		}
		capabilities.Freshness.ExpiresAt = &past
		capabilities.Provenance.Source = core.ModelCapabilitySourceOperatorOverride
		if preparedModelCapabilities(capabilities, d, payload, now) {
			t.Fatalf("operator %s denial expired", feature)
		}
	}
}
