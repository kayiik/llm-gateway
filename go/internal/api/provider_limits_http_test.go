package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/iam"
	"llmgw/internal/router"
)

func TestProviderLimitsHTTPFallbackAccountingAndAllLimited(t *testing.T) {
	gateway := useExtensionsAPI(t, true)
	t.Cleanup(func() { router.ResetSavingsState(); router.ResetTelemetryState() })
	admin := &adminCalls{t: t, server: gateway}
	var callsA, callsB atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			writeJSON(w, 200, map[string]any{"object": "list", "data": []any{map[string]any{"id": "m", "object": "model"}}})
			return
		}
		content, input, output := "answer-b", 2, 3
		if strings.HasPrefix(r.URL.Path, "/a/") {
			callsA.Add(1)
			content, input, output = "answer-a", 7, 11
		} else {
			callsB.Add(1)
		}
		writeJSON(w, 200, map[string]any{
			"id": "chatcmpl-limits", "object": "chat.completion", "model": "m",
			"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": content}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": input, "completion_tokens": output, "total_tokens": input + output},
		})
	}))
	defer upstream.Close()
	installLimitHTTPProviders(t, admin, upstream.URL)
	setLimit := func(provider string, limits map[string]any) {
		t.Helper()
		if status, body := admin.call(http.MethodPatch, "/admin/api/providers/"+provider+"/usage-limits", map[string]any{"usage_limits": limits}); status != 200 {
			t.Fatalf("limits status=%d body=%v", status, body)
		}
	}
	setLimit("a", map[string]any{"daily_tokens": 1})
	setLimit("b", map[string]any{"daily_tokens": 1, "models": map[string]any{"m": map[string]any{"monthly_tokens": 1}}})
	if status, body := jsonRequest(t, gateway.URL+"/v1/chat/completions", http.MethodPost, "admin-secret", limitHTTPChat("a/m", false)); status != 200 {
		t.Fatalf("warm a status=%d body=%v", status, body)
	}
	key := issueLimitHTTPKey(t)
	status, answer := jsonRequest(t, gateway.URL+"/v1/chat/completions", http.MethodPost, key.Token, limitHTTPChat("limited-chain", false))
	if status != 200 || !strings.Contains(string(mustJSON(t, answer)), "answer-b") || callsA.Load() != 1 || callsB.Load() != 1 {
		t.Fatalf("fallback status=%d body=%v a=%d b=%d", status, answer, callsA.Load(), callsB.Load())
	}
	events := waitLimitHTTPEvents(t, key.ID, 1)
	if len(events) != 1 || events[0].Provider != "b" || events[0].RoutedModel != "m" || events[0].InputTokens != 2 || events[0].OutputTokens != 3 {
		t.Fatalf("logical actual-target usage=%+v", events)
	}
	db, err := iam.DB()
	if err != nil {
		t.Fatal(err)
	}
	var requests, input, output int64
	if err := db.QueryRow(`SELECT requests,input_tokens,output_tokens FROM quota_counters WHERE key_id=? AND period='day'`, key.ID).Scan(&requests, &input, &output); err != nil {
		t.Fatal(err)
	}
	if requests != 1 || input != 2 || output != 3 {
		t.Fatalf("caller counted more than one logical request: requests=%d input=%d output=%d", requests, input, output)
	}
	assertLimitHTTPTarget(t, "a", "", 1, 18)
	assertLimitHTTPTarget(t, "a", "m", 1, 18)
	assertLimitHTTPTarget(t, "b", "", 1, 5)
	assertLimitHTTPTarget(t, "b", "m", 1, 5)
	status, answer = jsonRequest(t, gateway.URL+"/v1/chat/completions", http.MethodPost, key.Token, limitHTTPChat("limited-chain", false))
	if status != http.StatusTooManyRequests || callsA.Load() != 1 || callsB.Load() != 1 {
		t.Fatalf("all-limited status=%d body=%v a=%d b=%d", status, answer, callsA.Load(), callsB.Load())
	}
	assertLimitHTTPTarget(t, "a", "", 1, 18)
	assertLimitHTTPTarget(t, "b", "", 1, 5)
}

func TestProviderLimitsHTTPPartialStreamNeverSplicesFallback(t *testing.T) {
	gateway := useExtensionsAPI(t, true)
	t.Cleanup(func() { router.ResetSavingsState(); router.ResetTelemetryState() })
	admin := &adminCalls{t: t, server: gateway}
	var callsA, callsB atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			writeJSON(w, 200, map[string]any{"data": []any{map[string]any{"id": "m", "object": "model"}}})
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/a/") {
			callsB.Add(1)
			_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"fallback-splice\"}}]}\n\ndata: [DONE]\n\n")
			return
		}
		callsA.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Length", "99999") // Force transport failure after visible output and usage.
		_, _ = io.WriteString(w, "data: {\"id\":\"partial\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial-a\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":5,\"total_tokens\":12}}\n\n")
		w.(http.Flusher).Flush()
	}))
	defer upstream.Close()
	installLimitHTTPProviders(t, admin, upstream.URL)
	for _, provider := range []string{"a", "b"} {
		if status, body := admin.call(http.MethodPatch, "/admin/api/providers/"+provider+"/usage-limits", map[string]any{"usage_limits": map[string]any{"daily_tokens": 100}}); status != 200 {
			t.Fatalf("limits status=%d body=%v", status, body)
		}
	}
	key := issueLimitHTTPKey(t)
	encoded, _ := json.Marshal(limitHTTPChat("limited-chain", true))
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, gateway.URL+"/v1/chat/completions", bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+key.Token)
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(response.Body)
	if response.StatusCode != 200 || !strings.Contains(string(body), "partial-a") || strings.Contains(string(body), "fallback-splice") || callsA.Load() != 1 || callsB.Load() != 0 {
		t.Fatalf("partial stream status=%d read=%v a=%d b=%d body=%s", response.StatusCode, readErr, callsA.Load(), callsB.Load(), body)
	}
	events := waitLimitHTTPEvents(t, key.ID, 1)
	if len(events) != 1 || events[0].Provider != "a" || events[0].ErrorCode == "" {
		t.Fatalf("partial failure logical usage=%+v", events)
	}
	assertLimitHTTPTarget(t, "a", "", 1, 12)
	assertLimitHTTPTarget(t, "a", "m", 1, 12)
	db, err := iam.DB()
	if err != nil {
		t.Fatal(err)
	}
	var second int
	if err := db.QueryRow(`SELECT COUNT(*) FROM target_quota_counters WHERE provider_id='b'`).Scan(&second); err != nil || second != 0 {
		t.Fatalf("undispatched fallback target counters=%d err=%v", second, err)
	}
}

func installLimitHTTPProviders(t *testing.T, admin *adminCalls, upstream string) {
	t.Helper()
	for _, provider := range []string{"a", "b"} {
		if status, body := admin.call(http.MethodPost, "/admin/api/providers", map[string]any{"id": provider, "type": "openai_compatible", "base_url": upstream + "/" + provider}); status != 200 {
			t.Fatalf("provider status=%d body=%v", status, body)
		}
	}
	if status, body := admin.call(http.MethodPost, "/admin/api/endpoints", map[string]any{
		"name": "limited-chain", "failover": []any{
			map[string]any{"provider": "a", "model": "m", "allow_unverified": true},
			map[string]any{"provider": "b", "model": "m", "allow_unverified": true},
		},
	}); status != 200 {
		t.Fatalf("endpoint status=%d body=%v", status, body)
	}
}

func issueLimitHTTPKey(t *testing.T) iam.IssuedKey {
	t.Helper()
	project, err := iam.CreateProject("limit-http", "Limit HTTP")
	if err != nil {
		t.Fatal(err)
	}
	principal, err := iam.CreatePrincipal("service", "", "", "Limit HTTP caller")
	if err != nil {
		t.Fatal(err)
	}
	if err := iam.SetMembership(project.ID, principal.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	key, err := iam.IssueKey(iam.KeyCreate{ProjectID: project.ID, PrincipalID: principal.ID, Name: "http", Policy: iam.KeyPolicy{DailyRequests: 10}})
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func limitHTTPChat(model string, stream bool) map[string]any {
	return map[string]any{"model": model, "stream": stream, "messages": []any{map[string]any{"role": "user", "content": "synthetic"}}}
}

func waitLimitHTTPEvents(t *testing.T, key string, count int) []iam.RecordedRequest {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		events, _, err := iam.ListUsageEvents(iam.UsageEventFilter{KeyID: key})
		if err != nil {
			t.Fatal(err)
		}
		if len(events) >= count {
			return events
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d logical usage events: %+v", count, events)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func assertLimitHTTPTarget(t *testing.T, provider, model string, wantRequests, wantTokens int64) {
	t.Helper()
	db, err := iam.DB()
	if err != nil {
		t.Fatal(err)
	}
	var requests, tokens int64
	if err := db.QueryRow(`SELECT SUM(requests),SUM(observed_tokens) FROM target_quota_counters WHERE provider_id=? AND model=? AND period='day'`, provider, model).Scan(&requests, &tokens); err != nil {
		t.Fatal(err)
	}
	if requests != wantRequests || tokens != wantTokens {
		t.Fatalf("target %s/%s requests=%d tokens=%d want=%d/%d", provider, model, requests, tokens, wantRequests, wantTokens)
	}
}
