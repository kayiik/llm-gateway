package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"

	core "github.com/kayiik/llmgw-core"
)

const realtimeOfferFixture = "v=0\r\ns=fixture-offer\r\nt=0 0\r\na=ice-pwd:fixture-offer-credential\r\n"
const realtimeAnswerFixture = "v=0\r\ns=fixture-answer\r\nt=0 0\r\na=ice-pwd:fixture-answer-credential\r\n"

func realtimeFixture(t *testing.T, respond http.HandlerFunc, nativeSurfaces ...string) (http.Handler, *atomic.Int32) {
	t.Helper()
	if len(nativeSurfaces) == 0 {
		nativeSurfaces = []string{realtimeCallsPath}
	}
	resetState(t)
	// ResetProviders preserves catalog evidence; each fixture owns its runtime
	// so another fixture's native transport declaration cannot leak into it.
	providers.InstallForTests(t)
	t.Setenv("LLMGW_CONFIG", config.StateDir()+"/config.yaml")
	old := *config.Get()
	t.Cleanup(func() { config.Update(func(s *config.Settings) { *s = old }) })
	calls := &atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/models" {
			writeJSON(w, http.StatusOK, map[string]any{"data": []any{
				map[string]any{"id": "voice-model", "supported_endpoints": nativeSurfaces},
				map[string]any{"id": "chat-model", "supported_endpoints": []string{"/chat/completions"}},
			}})
			return
		}
		calls.Add(1)
		if respond != nil {
			respond(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/sdp")
		w.Header().Set("Location", "/v1/realtime/calls/rtc_fixture")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, realtimeAnswerFixture)
	}))
	t.Cleanup(upstream.Close)
	config.Update(func(s *config.Settings) {
		s.APIKey, s.APIKeys, s.AllowUnauthenticatedAPI, s.SSOEnabled = "gateway-fixture", nil, false, false
		s.GatewayPreamble, s.CredentialEncryptionKey = "", ""
		s.Providers = map[string]*config.ProviderConfig{
			"fixture": {Type: "openai_compatible", BaseURL: upstream.URL + "/v1", APIKey: "fixture-provider-key"},
			"studio":  {Type: "ai_studio", BaseURL: upstream.URL + "/v1", APIKey: "fixture-provider-key"},
		}
		s.Endpoints = map[string]*config.EndpointConfig{
			"voice":     {Ingress: []string{"/v1/realtime/calls"}, Failover: []config.EndpointMember{{Provider: "studio", Model: "fixture"}, {Provider: "fixture", Model: "voice-model"}}},
			"chat-only": {Ingress: []string{"/v1/chat/completions"}, Failover: []config.EndpointMember{{Provider: "fixture", Model: "voice-model"}}},
		}
		s.Policies.Defaults = config.ProviderPolicy{RetryMaxAttempts: 3}
		s.Policies.Overrides = nil
	})
	return NewServer(Runtime{}), calls
}

func realtimeForm(t *testing.T, fields ...[2]string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, field := range fields {
		if err := writer.WriteField(field[0], field[1]); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}

func realtimeRequest(t *testing.T, handler http.Handler, path, token, session string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := realtimeForm(t, [2]string{"sdp", realtimeOfferFixture}, [2]string{"session", session})
	request := httptest.NewRequest(http.MethodPost, path, body)
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Authorization", "Bearer "+token)
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestRealtimeCallsForwardSDPAndFrozenSession(t *testing.T) {
	for _, path := range []string{"/v1/realtime/calls", "/realtime/calls"} {
		t.Run(path, func(t *testing.T) {
			handler, calls := realtimeFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/realtime/calls" || r.Header.Get("Authorization") != "Bearer fixture-provider-key" {
					t.Errorf("wrong realtime target/credential: %s", r.URL.Path)
				}
				if err := r.ParseMultipartForm(1 << 20); err != nil {
					t.Error(err)
					return
				}
				if r.FormValue("sdp") != realtimeOfferFixture {
					t.Error("SDP offer changed")
				}
				var session map[string]any
				if err := decodeInferenceBody(strings.NewReader(r.FormValue("session")), &session); err != nil {
					t.Error(err)
					return
				}
				if session["model"] != "voice-model" || session["instructions"] != "retain <caller> instructions" || session["provider_number"] != json.Number("9007199254740993") || !strings.Contains(r.FormValue("session"), `"voice":"marin"`) {
					t.Errorf("native session changed: %s", r.FormValue("session"))
				}
				w.Header().Set("Content-Type", "application/sdp")
				w.Header().Set("Location", "http://"+r.Host+"/v1/realtime/calls/rtc_fixture")
				w.WriteHeader(http.StatusCreated)
				_, _ = io.WriteString(w, realtimeAnswerFixture)
			})
			session := `{"type":"realtime","model":"voice","instructions":"retain <caller> instructions","provider_number":9007199254740993,"audio":{"output":{"voice":"marin"}},"tools":[{"type":"function","name":"fixture","parameters":{"type":"object"}}]}`
			response := realtimeRequest(t, handler, path, "gateway-fixture", session, nil)
			if response.Code != http.StatusCreated || response.Body.String() != realtimeAnswerFixture || response.Header().Get("Content-Type") != "application/sdp" || response.Header().Get("Location") != "/v1/realtime/calls/rtc_fixture" {
				t.Fatalf("answer changed: status=%d headers=%v body=%q", response.Code, response.Header(), response.Body.String())
			}
			if response.Header().Get("X-LLMGW-Usage-Scope") != "signaling" || calls.Load() != 1 {
				t.Fatalf("missing signaling scope or extra calls: headers=%v calls=%d", response.Header(), calls.Load())
			}
			db, err := iam.DB()
			if err != nil {
				t.Fatal(err)
			}
			var raw, provider, model string
			var input, output int
			if err := db.QueryRow(`SELECT provider,routed_model,input_tokens,output_tokens,source_usage_json FROM usage_events WHERE endpoint='openai.realtime.calls'`).Scan(&provider, &model, &input, &output, &raw); err != nil {
				t.Fatal(err)
			}
			var evidence iam.UsageEvidence
			if err := json.Unmarshal([]byte(raw), &evidence); err != nil || provider != "fixture" || model != "voice-model" || input != 0 || output != 0 || evidence.InputBasis != "unobserved_session" || evidence.OutputBasis != "unobserved_session" || !evidence.InputIncomplete || !evidence.OutputIncomplete || evidence.SelectedAttempt != -1 || !evidence.SelectionUnavailable || len(evidence.Attempts) != 1 {
				t.Fatalf("signaling became fictional usage: provider=%s model=%s evidence=%s err=%v", provider, model, raw, err)
			}
			if attempt := evidence.Attempts[0]; attempt.API != "realtime_calls" || attempt.Quality != "unknown" || len(attempt.Counts) != 0 {
				t.Fatalf("signaling inferred media usage/completion: %+v", attempt)
			}
		})
	}
}

func TestRealtimeLocalRejectionsPrecedeAdmission(t *testing.T) {
	handler, calls := realtimeFixture(t, nil)
	token := admissionFixtureKey(t, "realtime-admission", iam.KeyPolicy{DailyRequests: 1, RoutesOnly: true, AllowedRoutes: []string{"voice", "chat-only"}})
	for _, fields := range [][][2]string{
		{{"session", `{"type":"realtime","model":"voice"}`}},
		{{"sdp", realtimeOfferFixture}},
		{{"sdp", realtimeOfferFixture}, {"sdp", "another"}, {"session", `{"type":"realtime","model":"voice"}`}},
		{{"sdp", realtimeOfferFixture}, {"session", `{"type":"realtime","model":"voice"}`}, {"session", `{"type":"realtime","model":"fixture/other"}`}},
		{{"sdp", realtimeOfferFixture}, {"session", `{"type":"realtime","model":"voice"} {}`}},
		{{"sdp", realtimeOfferFixture}, {"session", `[]`}},
		{{"sdp", realtimeOfferFixture}, {"session", `{"type":"transcription","model":"voice"}`}},
		{{"sdp", realtimeOfferFixture}, {"session", `{"type":"realtime"}`}},
		{{"sdp", realtimeOfferFixture}, {"session", `{"type":"realtime","model":"voice"}`}, {"unmapped", "control"}},
	} {
		body, contentType := realtimeForm(t, fields...)
		request := httptest.NewRequest(http.MethodPost, "/v1/realtime/calls", body)
		request.Header.Set("Content-Type", contentType)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid realtime form accepted: status=%d body=%s", response.Code, response.Body.String())
		}
	}
	for _, tc := range []struct {
		session string
		headers http.Header
	}{
		{`{"type":"realtime","model":"chat-only"}`, http.Header{compatibilityHeader: {"allow"}}},
		{`{"type":"realtime","model":"voice"}`, http.Header{compatibilityHeader: {"allow", "deny"}}},
		{`{"type":"realtime","model":"voice"}`, http.Header{transportModeHeader: {"transparent"}}},
	} {
		response := realtimeRequest(t, handler, "/v1/realtime/calls", token, tc.session, tc.headers)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("policy broadened realtime admission: status=%d body=%s", response.Code, response.Body.String())
		}
	}
	if key, project := consumedRequests(t); key != 0 || project != 0 || calls.Load() != 0 {
		t.Fatalf("rejected signaling consumed quota: key=%d project=%d upstream=%d", key, project, calls.Load())
	}
	valid := `{"type":"realtime","model":"voice"}`
	if response := realtimeRequest(t, handler, "/v1/realtime/calls", token, valid, nil); response.Code != http.StatusCreated {
		t.Fatalf("valid signaling refused: status=%d body=%s", response.Code, response.Body.String())
	}
	if response := realtimeRequest(t, handler, "/v1/realtime/calls", token, valid, nil); response.Code != http.StatusTooManyRequests {
		t.Fatalf("signaling bypassed request quota: status=%d body=%s", response.Code, response.Body.String())
	}
	if key, project := consumedRequests(t); key != 1 || project != 1 || calls.Load() != 1 {
		t.Fatalf("signaling admission was not singular: key=%d project=%d upstream=%d", key, project, calls.Load())
	}
}

func TestRealtimeNativeCatalogRestriction(t *testing.T) {
	handler, calls := realtimeFixture(t, nil)
	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request.Header.Set("Authorization", "Bearer gateway-fixture")
	principal, ok := authed(httptest.NewRecorder(), request)
	if !ok {
		t.Fatal("fixture principal unavailable")
	}
	if rows := providers.RefreshCatalogForPrincipal("fixture", callerOf(principal)); len(rows) != 2 {
		t.Fatalf("fixture native catalog unavailable: %v", rows)
	}
	response := realtimeRequest(t, handler, "/v1/realtime/calls", "gateway-fixture", `{"type":"realtime","model":"fixture/chat-model"}`, nil)
	if response.Code != http.StatusBadRequest || calls.Load() != 0 {
		t.Fatalf("Chat-only declaration became realtime: status=%d calls=%d", response.Code, calls.Load())
	}
	response = realtimeRequest(t, handler, "/v1/realtime/calls", "gateway-fixture", `{"type":"realtime","model":"fixture/voice-model"}`, nil)
	if response.Code != http.StatusCreated || calls.Load() != 1 {
		t.Fatalf("declared native signaling refused: status=%d calls=%d body=%s", response.Code, calls.Load(), response.Body.String())
	}
	response = realtimeRequest(t, handler, "/v1/realtime/calls", "gateway-fixture", `{"type":"realtime","model":"fixture/uncatalogued-model"}`, nil)
	if response.Code != http.StatusCreated || calls.Load() != 2 {
		t.Fatalf("missing model evidence became a negative declaration: status=%d calls=%d", response.Code, calls.Load())
	}
}

func TestRealtimeErrorsNeverRetryOrReturnSDPDiagnostics(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusServiceUnavailable, http.StatusTemporaryRedirect} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			handler, calls := realtimeFixture(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Retry-After", "7")
				w.Header().Set("Location", "https://example.invalid/private-target")
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"error":{"message":"fixture-provider-key fixture-offer-credential private diagnostic"}}`)
			})
			response := realtimeRequest(t, handler, "/v1/realtime/calls", "gateway-fixture", `{"type":"realtime","model":"voice"}`, nil)
			if response.Code != status || calls.Load() != 1 || response.Header().Get("Retry-After") != "7" || response.Header().Get("Location") != "" {
				t.Fatalf("realtime refusal changed/replayed: status=%d calls=%d headers=%v", response.Code, calls.Load(), response.Header())
			}
			for _, secret := range []string{"fixture-provider-key", "fixture-offer-credential", "private diagnostic"} {
				if strings.Contains(response.Body.String(), secret) {
					t.Fatal("realtime error exposed private request/provider content")
				}
			}
		})
	}
}

func TestRealtimeInvalidAnswersAreNotReturnedAsSDP(t *testing.T) {
	for _, answer := range []struct{ contentType, body string }{
		{"application/sdp", ""}, {"application/sdp", `{"error":"private provider diagnostic"}`}, {"application/sdp", "<html>not SDP</html>"},
		{"application/json", realtimeAnswerFixture}, {"invalid;=mime", realtimeAnswerFixture},
	} {
		handler, calls := realtimeFixture(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", answer.contentType)
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, answer.body)
		})
		response := realtimeRequest(t, handler, "/v1/realtime/calls", "gateway-fixture", `{"type":"realtime","model":"voice"}`, nil)
		if response.Code != http.StatusBadGateway || calls.Load() != 1 || response.Header().Get("Content-Type") != "application/json" || strings.Contains(response.Body.String(), "private provider diagnostic") {
			t.Fatalf("invalid answer accepted/exposed: status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
		}
	}
}

func TestRealtimeCancellationClosesSignalingRequest(t *testing.T) {
	started, closed := make(chan struct{}), make(chan struct{})
	handler, calls := realtimeFixture(t, func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(closed)
	})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	body, contentType := realtimeForm(t, [2]string{"sdp", realtimeOfferFixture}, [2]string{"session", `{"type":"realtime","model":"voice"}`})
	request := httptest.NewRequest(http.MethodPost, "/v1/realtime/calls", body).WithContext(ctx)
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Authorization", "Bearer gateway-fixture")
	done := make(chan struct{})
	go func() { defer close(done); handler.ServeHTTP(httptest.NewRecorder(), request) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("signaling request did not reach fixture")
	}
	cancel()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled signaling left its upstream open")
	}
	<-done
	if count, status, _, code := usageOutcome(t); count != 1 || status != 499 || code != "client_cancelled" || calls.Load() != 1 {
		t.Fatalf("cancelled signaling outcome: count=%d status=%d code=%q calls=%d", count, status, code, calls.Load())
	}
}

func TestRealtimeSDPIsExcludedFromBodyLogs(t *testing.T) {
	resetState(t)
	for _, path := range []string{"/v1/realtime/calls", "/realtime/calls", "/v1/realtime/calls/rtc_fixture/accept", "/realtime/calls/"} {
		request := httptest.NewRequest(http.MethodPost, path, nil)
		writeRequestLog(request, []byte(realtimeOfferFixture), int64(len(realtimeOfferFixture)), http.StatusCreated,
			[]byte(realtimeAnswerFixture), int64(len(realtimeAnswerFixture)), time.Millisecond, true, "")
	}
	raw, err := os.ReadFile(requestLogPath())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "fixture-offer-credential") || strings.Contains(string(raw), "fixture-answer-credential") || strings.Contains(string(raw), "ice-pwd") {
		t.Fatal("SDP ICE credentials reached request logs")
	}
	if !strings.Contains(string(raw), `"request_bytes":`) || !strings.Contains(string(raw), `"response_bytes":`) {
		t.Fatal("signaling metadata was not recorded")
	}
}

type realtimeChangingReader struct {
	io.Reader
	change func()
}

func (r *realtimeChangingReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if r.change != nil {
		change := r.change
		r.change = nil
		change()
	}
	return n, err
}

func TestRealtimeConfigurationChangeDoesNotSpendQuota(t *testing.T) {
	handler, calls := realtimeFixture(t, nil)
	token := admissionFixtureKey(t, "realtime-generation", iam.KeyPolicy{DailyRequests: 1})
	body, contentType := realtimeForm(t, [2]string{"sdp", realtimeOfferFixture}, [2]string{"session", `{"type":"realtime","model":"voice"}`})
	reader := &realtimeChangingReader{Reader: body, change: func() {
		config.Update(func(s *config.Settings) { s.GatewayPreamble = "fixture configuration change" })
	}}
	request := httptest.NewRequest(http.MethodPost, "/v1/realtime/calls", reader)
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusConflict || calls.Load() != 0 {
		t.Fatalf("changed signaling binding dispatched: status=%d calls=%d body=%s", response.Code, calls.Load(), response.Body.String())
	}
	if key, project := consumedRequests(t); key != 0 || project != 0 {
		t.Fatalf("stale signaling spent key=%d project=%d", key, project)
	}
}

func TestRealtimeRequiresAuthenticationAndProviderScope(t *testing.T) {
	handler, calls := realtimeFixture(t, nil)
	response := realtimeRequest(t, handler, "/v1/realtime/calls", "unrecognized-fixture-key", `{"type":"realtime","model":"voice"}`, nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated signaling accepted: status=%d", response.Code)
	}
	token := admissionFixtureKey(t, "realtime-scope", iam.KeyPolicy{RoutesOnly: true, AllowedRoutes: []string{"voice"}, AllowedProviders: []string{"studio"}})
	response = realtimeRequest(t, handler, "/v1/realtime/calls", token, `{"type":"realtime","model":"voice"}`, nil)
	if response.Code != http.StatusBadRequest || calls.Load() != 0 {
		t.Fatalf("realtime selection escaped provider scope: status=%d calls=%d body=%s", response.Code, calls.Load(), response.Body.String())
	}
}

func TestRealtimeBoundedFormDoesNotSpendQuota(t *testing.T) {
	handler, calls := realtimeFixture(t, nil)
	t.Setenv("LLMGW_MAX_REQUEST_BODY_BYTES", "1048576")
	token := admissionFixtureKey(t, "realtime-size", iam.KeyPolicy{DailyRequests: 1})
	session := `{"type":"realtime","model":"voice"}` + strings.Repeat(" ", lowestMaxRequestBodyBytes)
	body, contentType := realtimeForm(t, [2]string{"sdp", realtimeOfferFixture}, [2]string{"session", session})
	request := httptest.NewRequest(http.MethodPost, "/v1/realtime/calls", body)
	request.ContentLength = -1
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge || calls.Load() != 0 {
		t.Fatalf("oversized signaling form was not bounded: status=%d calls=%d", response.Code, calls.Load())
	}
	if key, project := consumedRequests(t); key != 0 || project != 0 {
		t.Fatalf("oversized signaling spent key=%d project=%d", key, project)
	}
}

func TestRealtimeUpstreamBodyFailureClosesResponse(t *testing.T) {
	handler, _ := realtimeFixture(t, nil)
	body := &failingReadCloser{}
	previousClient := audioClient
	audioClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusCreated, Header: http.Header{"Content-Type": {"application/sdp"}}, Body: body}, nil
	})}
	t.Cleanup(func() { audioClient = previousClient })
	response := realtimeRequest(t, handler, "/v1/realtime/calls", "gateway-fixture", `{"type":"realtime","model":"voice"}`, nil)
	if response.Code != http.StatusBadGateway || !body.closed {
		t.Fatalf("failed SDP answer returned or left open: status=%d closed=%t", response.Code, body.closed)
	}
	if count, status, _, code := usageOutcome(t); count != 1 || status != http.StatusBadGateway || code != "invalid_upstream_response" {
		t.Fatalf("failed signaling outcome: count=%d status=%d code=%q", count, status, code)
	}
}

func TestRealtimeCallLocationKeepsOnlyLocalResourceIDs(t *testing.T) {
	for _, tc := range []struct{ location, want string }{
		{"/v1/realtime/calls/rtc_fixture", "/v1/realtime/calls/rtc_fixture"},
		{"https://provider.example/v1/realtime/calls/rtc_fixture", "/v1/realtime/calls/rtc_fixture"},
		{"https://other.example/v1/realtime/calls/rtc_fixture", ""},
		{"//other.example/v1/realtime/calls/rtc_fixture", ""},
		{"/v1/realtime/calls/rtc_fixture?secret=fixture", ""},
		{"/v1/realtime/calls/rtc_fixture#fragment", ""},
		{"/v1/realtime/calls/rtc_fixture/accept", ""},
		{"/v1/realtime/calls/..", ""},
		{"/v1/realtime/calls/rtc%2Ffixture", ""},
	} {
		if got := realtimeCallLocation(tc.location, "https://provider.example/v1"); got != tc.want {
			t.Fatalf("location=%q got=%q want=%q", tc.location, got, tc.want)
		}
	}
}

func TestRealtimeCatalogListsDeclaredNativeAPI(t *testing.T) {
	handler, _ := realtimeFixture(t, nil)
	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request.Header.Set("Authorization", "Bearer gateway-fixture")
	principal, ok := authed(httptest.NewRecorder(), request)
	if !ok {
		t.Fatal("fixture principal unavailable")
	}
	if rows := providers.RefreshCatalogForPrincipal("fixture", callerOf(principal)); len(rows) != 2 {
		t.Fatalf("fixture catalog unavailable: %v", rows)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var catalog struct{ Data []map[string]any }
	if err := json.Unmarshal(response.Body.Bytes(), &catalog); err != nil || response.Code != http.StatusOK {
		t.Fatalf("model catalog failed: status=%d err=%v", response.Code, err)
	}
	for _, row := range catalog.Data {
		if row["id"] != "fixture/voice-model" {
			continue
		}
		if got := jsonStr(row["native_surfaces"]); !strings.Contains(got, "/v1/realtime/calls") {
			t.Fatalf("native signaling missing from discovery: %s", jsonStr(row))
		}
		if strings.Contains(jsonStr(row["emulated_surfaces"]), "realtime") {
			t.Fatal("signaling was advertised as an adaptation")
		}
		return
	}
	t.Fatal("declared realtime model missing from catalog")
}

func TestRealtimeCatalogEvidenceExpiryAndStaticDeclaration(t *testing.T) {
	now := time.Now()
	for _, surfaces := range [][]string{{"/realtime/calls"}, {"/chat/completions"}} {
		row := providers.ModelInfo{SupportedSurfaces: surfaces}
		if got := realtimeCatalogSupport(row, now.Add(-2*transportCatalogFreshness), now); got != core.SupportUnknown {
			t.Fatalf("expired API evidence remained authoritative: %v", got)
		}
		row.TypedCapabilities = &core.ModelCapabilities{SchemaVersion: core.ModelCapabilitiesSchemaVersion, Provenance: core.ModelCapabilityProvenance{Source: core.ModelCapabilitySourceOperatorOverride}}
		want := core.SupportUnsupported
		if slices.Contains(surfaces, "/realtime/calls") {
			want = core.SupportSupported
		}
		if got := realtimeCatalogSupport(row, time.Time{}, now); got != want {
			t.Fatalf("static API declaration lost authority: got=%v want=%v", got, want)
		}
	}
}

func TestRealtimeUsesRegisteredTransportRatherThanLegacyConfigShape(t *testing.T) {
	handler, calls := realtimeFixture(t, nil)
	config.Update(func(s *config.Settings) {
		s.Providers["subscription"] = &config.ProviderConfig{Type: "openai_compatible", RegistryID: "openai_codex"}
		voice := *s.Endpoints["voice"]
		voice.Failover = append([]config.EndpointMember{{Provider: "subscription", Model: "fixture"}}, voice.Failover...)
		s.Endpoints["voice"] = &voice
	})
	response := realtimeRequest(t, handler, "/v1/realtime/calls", "gateway-fixture", `{"type":"realtime","model":"voice"}`, nil)
	if response.Code != http.StatusCreated || calls.Load() != 1 {
		t.Fatalf("legacy configuration was mistaken for a native HTTP driver: status=%d calls=%d body=%s", response.Code, calls.Load(), response.Body.String())
	}
}
