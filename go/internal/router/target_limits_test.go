package router

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/config"
	"llmgw/internal/iam"
)

func TestPreparedTargetLimitsFallbackAndSourceSettlement(t *testing.T) {
	for _, streamMode := range []bool{false, true} {
		t.Run(map[bool]string{false: "invoke", true: "stream"}[streamMode], func(t *testing.T) {
			t.Setenv("LLMGW_STATE_DIR", t.TempDir())
			iam.ResetForTests()
			t.Cleanup(iam.ResetForTests)
			var first, second atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/first/") {
					first.Add(1)
				} else {
					second.Add(1)
				}
				if streamMode {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":5,\"total_tokens\":12}}\n\ndata: [DONE]\n\n")
				} else {
					_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"answer"}}],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}`)
				}
			}))
			defer server.Close()
			rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{
				"first":  {Type: "openai_compatible", BaseURL: server.URL + "/first", UsageLimits: &config.ProviderUsageLimits{TargetUsageLimits: config.TargetUsageLimits{DailyTokens: 10}}},
				"second": {Type: "openai_compatible", BaseURL: server.URL + "/second"},
			})
			for attempt := 0; attempt < 2; attempt++ {
				options := PreparedOptions{Generation: config.Generation()}
				if streamMode {
					options.Preparation.Mode = core.CallModeStream
				}
				p, err := rt.PrepareRequest(t.Context(), []Target{{Provider: "first", Model: "m"}, {Provider: "second", Model: "m"}}, core.LocalCaller(), preparedRouterRequest(), options)
				if err != nil {
					t.Fatal(err)
				}
				var served *Target
				if streamMode {
					var stream core.StreamIter
					stream, served, _, err = p.Stream(t.Context(), "route")
					if err == nil {
						for {
							_, next := stream.Next()
							if next == io.EOF {
								break
							}
							if next != nil {
								t.Fatal(next)
							}
						}
						if closeErr := stream.Close(); closeErr != nil {
							t.Fatal(closeErr)
						}
						_ = stream.Close()
					}
				} else {
					_, served, _, err = p.Invoke(t.Context(), "route")
				}
				want := "first"
				if attempt == 1 {
					want = "second"
				}
				if err != nil || served == nil || served.Provider != want {
					t.Fatalf("attempt=%d served=%v err=%v", attempt, served, err)
				}
			}
			if first.Load() != 1 || second.Load() != 1 {
				t.Fatalf("dispatches first=%d second=%d", first.Load(), second.Load())
			}
			db, err := iam.DB()
			if err != nil {
				t.Fatal(err)
			}
			var requests, tokens int64
			if err := db.QueryRow(`SELECT requests,observed_tokens FROM target_quota_counters WHERE provider_id='first' AND model='m' AND period='day'`).Scan(&requests, &tokens); err != nil {
				t.Fatal(err)
			}
			if requests != 1 || tokens != 12 {
				t.Fatalf("requests=%d tokens=%d", requests, tokens)
			}
		})
	}
}

func TestPreparedTargetLimitsGateRetriesWithoutReplayingRejectedTarget(t *testing.T) {
	var first, second atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/first/") {
			first.Add(1)
			w.WriteHeader(503)
			return
		}
		second.Add(1)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"fallback"}}]}`)
	}))
	defer server.Close()
	rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{
		"first":  {Type: "openai_compatible", BaseURL: server.URL + "/first", UsageLimits: &config.ProviderUsageLimits{TargetUsageLimits: config.TargetUsageLimits{RPM: 1}}},
		"second": {Type: "openai_compatible", BaseURL: server.URL + "/second"},
	})
	config.Update(func(s *config.Settings) { s.Policies.Defaults.RetryMaxAttempts = 3 })
	p, err := rt.PrepareRequest(t.Context(), []Target{{Provider: "first", Model: "m"}, {Provider: "second", Model: "m"}}, core.LocalCaller(), preparedRouterRequest(), PreparedOptions{Generation: config.Generation()})
	if err != nil {
		t.Fatal(err)
	}
	_, served, _, err := p.Invoke(t.Context(), "route")
	if err != nil || served == nil || served.Provider != "second" || first.Load() != 1 || second.Load() != 1 {
		t.Fatalf("served=%v first=%d second=%d err=%v", served, first.Load(), second.Load(), err)
	}
}
