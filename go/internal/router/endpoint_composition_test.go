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
)

func TestComposedRouteUsesExistingPreparedFallbackBoundary(t *testing.T) {
	for _, mode := range []string{"invoke", "stream opening failure", "stream partial failure"} {
		t.Run(mode, func(t *testing.T) {
			var first, second atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/first/") {
					first.Add(1)
					if mode != "stream partial failure" {
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
					w.(http.Flusher).Flush()
					panic(http.ErrAbortHandler)
				}
				second.Add(1)
				if mode == "invoke" {
					_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"fallback"}}]}`)
				} else {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"fallback\"}}]}\n\ndata: [DONE]\n\n")
				}
			}))
			defer server.Close()
			rt := preparedRouterFixture(t, map[string]*config.ProviderConfig{
				"first":  {Type: "openai_compatible", BaseURL: server.URL + "/first"},
				"second": {Type: "openai_compatible", BaseURL: server.URL + "/second"},
			})
			config.Update(func(settings *config.Settings) {
				settings.Endpoints = map[string]*config.EndpointConfig{
					"child": {Failover: []config.EndpointMember{{Provider: "first", Model: "m"}}},
					"route": {Failover: []config.EndpointMember{{Route: "child"}, {Provider: "second", Model: "m"}}},
				}
			})
			resolution, err := rt.ResolveForPrincipal(t.Context(), "route", core.LocalCaller())
			if err != nil || resolution.Category != "route" || len(resolution.Targets) != 2 {
				t.Fatalf("resolution=%+v err=%v", resolution, err)
			}
			options := PreparedOptions{Generation: config.Generation()}
			if mode != "invoke" {
				options.Preparation.Mode = core.CallModeStream
			}
			prepared, err := rt.PrepareRequest(t.Context(), resolution.Targets, core.LocalCaller(), preparedRouterRequest(), options)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "invoke" {
				_, served, traces, err := prepared.Invoke(t.Context(), "route")
				if err != nil || served == nil || served.Provider != "second" || len(traces) != 2 {
					t.Fatalf("served=%v traces=%v err=%v", served, traces, err)
				}
			} else {
				stream, served, _, err := prepared.Stream(t.Context(), "route")
				if err != nil {
					t.Fatal(err)
				}
				defer stream.Close()
				frame, err := stream.Next()
				if err != nil {
					t.Fatal(err)
				}
				if mode == "stream partial failure" {
					if served == nil || served.Provider != "first" || !strings.Contains(string(frame), "partial") {
						t.Fatalf("selected=%v frame=%s", served, frame)
					}
					if _, err := stream.Next(); err == nil || err == io.EOF {
						t.Fatalf("broken stream failure hidden: %v", err)
					}
				} else if served == nil || served.Provider != "second" || !strings.Contains(string(frame), "fallback") {
					t.Fatalf("selected=%v frame=%s", served, frame)
				}
			}
			wantSecond := int32(1)
			if mode == "stream partial failure" {
				wantSecond = 0
			}
			if first.Load() != 1 || second.Load() != wantSecond {
				t.Fatalf("unexpected inference/replay first=%d second=%d", first.Load(), second.Load())
			}
		})
	}
}
