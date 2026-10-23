package router

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	translate "github.com/kayiik/llm-translate"
	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/config"
)

func TestPreparedUsageHistoryRetainsTargetAssociationAcrossNativeRetriesAndFallback(t *testing.T) {
	var a, b atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/a/") {
			a.Add(1)
			w.WriteHeader(503)
			_, _ = io.WriteString(w, `{"error":{"message":"retry"},"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`)
			return
		}
		b.Add(1)
		_, _ = io.WriteString(w, `{"id":"c1","choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`)
	}))
	defer server.Close()
	rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{"A": {Type: "openai_compatible", BaseURL: server.URL + "/a"}, "B": {Type: "openai_compatible", BaseURL: server.URL + "/b"}})
	config.Update(func(settings *config.Settings) {
		settings.Policies.Overrides["A"] = config.ProviderPolicy{RetryMaxAttempts: 2}
	})
	request, err := rt.PrepareRequest(t.Context(), []Target{{Provider: "A", Model: "model-a"}, {Provider: "B", Model: "model-b"}}, core.LocalCaller(), preparedRouterRequest(), PreparedOptions{Generation: config.Generation()})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := request.Invoke(t.Context(), "route"); err != nil {
		t.Fatal(err)
	}
	history := core.SourceUsageHistoryOf(request)
	if len(history.Attempts) != 3 || history.Truncated || a.Load() != 2 || b.Load() != 1 {
		t.Fatalf("history/attempts=%+v calls=%d/%d", history, a.Load(), b.Load())
	}
	for index, record := range history.Attempts {
		instance, model, attempt, input, quality := "A", "model-a", uint64(index+1), int64(2), translate.CompletionFailed
		if index == 2 {
			instance, model, attempt, input, quality = "B", "model-b", 1, 5, translate.CompletionComplete
		}
		if record.Instance != instance || record.Model != model || record.Attempt != attempt || record.Usage.InputTokens.Value != input || record.Usage.Quality != quality {
			t.Fatalf("native retry association erased at%d: %+v", index, record)
		}
	}
	last, ok := core.SourceUsageOf(request)
	if !ok || last.Instance != "B" || last.Usage.OutputTokens.Value != 2 {
		t.Fatalf("latest selected source=%+v", last)
	}
}
