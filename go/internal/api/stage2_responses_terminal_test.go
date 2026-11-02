package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
	"llmgw/internal/router"
)

// These frames are reconstructed controls, not the missing original upstream
// frame. Exercise both the real prepared iterator and the public HTTP boundary.
func TestStage2PreparedResponsesTerminalHTTP(t *testing.T) {
	for _, mode := range []string{"usage-after-finish", "usage-with-finish", "usage-before-finish", "unknown-final", "opaque-final", "source-error"} {
		t.Run(mode, func(t *testing.T) {
			f := newNativePolicyFixture(t)
			f.catalogSurfaces = []string{"/chat/completions"}
			config.Update(func(s *config.Settings) {
				s.APIKey = "gateway-token"
				s.Providers["chat"].RegistryID = "openrouter"
			})
			providers.RefreshCatalog("chat")
			frames := stage2TerminalFrames(mode)
			var attempts atomic.Int32
			f.inference = func(w http.ResponseWriter, r *http.Request, body map[string]any) {
				attempts.Add(1)
				if r.URL.Path != "/chat/completions" || body["model"] != "fixture" || body["stream"] != true {
					t.Errorf("wrong native request: path=%s body=%+v", r.URL.Path, body)
				}
				w.Header().Set("Content-Type", "text/event-stream")
				for _, frame := range frames {
					_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
					w.(http.Flusher).Flush()
				}
				_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			}
			request := map[string]any{"model": "chat/fixture", "input": "Reply with exactly OK.", "stream": true}
			body, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			prepared, err := router.Current().PrepareRequest(ctx, []router.Target{{Provider: "chat", Model: "fixture"}}, core.Caller{ID: iam.AdminCallerID, Kind: core.CallerService}, core.Request{
				Surface: core.ModelSurfaceResponses, Model: "chat/fixture", Body: body, ContentType: core.ContentTypeJSON,
			}, router.PreparedOptions{
				Preparation: core.CallPreparationOptions{Mode: core.CallModeStream, AllowAdaptation: true},
				Policy:      core.CallPolicy{AllowAdaptation: true, RequireIncremental: true},
				Generation:  config.Generation(),
			})
			if err != nil {
				t.Fatal(err)
			}
			stream, _, _, err := prepared.Stream(ctx, "chat/fixture")
			if err != nil {
				t.Fatal(err)
			}
			var termination error
			for {
				_, err = stream.Next()
				if err != nil {
					termination = err
					break
				}
			}
			_ = stream.Close()
			failure := mode == "unknown-final" || mode == "opaque-final" || mode == "source-error"
			if !failure {
				if !errors.Is(termination, io.EOF) {
					t.Fatalf("conforming prepared stream: %T %v", termination, termination)
				}
			} else {
				var plan *core.CallPlanError
				var loss *core.LossPolicyError
				if !errors.As(termination, &plan) && !errors.As(termination, &loss) {
					t.Fatalf("missing actual typed policy failure: %T %v", termination, termination)
				}
				if mode == "opaque-final" {
					if loss == nil || plan != nil || len(loss.Losses) != 1 || loss.Losses[0].Path != "choices.0.delta.reasoning_details.0.data" {
						t.Fatalf("opaque first error: plan=%+v loss=%+v", plan, loss)
					}
				} else {
					path := "$.future_state"
					if mode == "source-error" {
						path = "$.error"
					}
					if plan == nil || loss != nil || plan.Reason != "stream_response_semantics_unassessed" || len(plan.UnknownPaths) != 1 || plan.UnknownPaths[0] != path {
						t.Fatalf("unknown/source first error: plan=%+v loss=%+v", plan, loss)
					}
				}
				diagnostic, err := json.Marshal(map[string]any{"reconstructed_mode": mode, "iterator_type": fmt.Sprintf("%T", termination), "plan": plan, "loss": loss, "offending_frame": json.RawMessage(frames[len(frames)-1])})
				if err != nil {
					t.Fatal(err)
				}
				t.Logf("synthetic iterator diagnostic: %s", diagnostic)
			}

			// The policy refusal must happen before any additional provider I/O.
			before := attempts.Load()
			status, raw := cliRequest(t, f.server.URL+"/v1/responses", request, "deny")
			if status != http.StatusBadRequest || attempts.Load() != before || !strings.Contains(string(raw), "adaptation_required") {
				t.Fatalf("native-only admission: status=%d attempts=%d/%d body=%s", status, attempts.Load(), before, raw)
			}
			requestID := "stage2-" + mode
			public, err := http.NewRequest(http.MethodPost, f.server.URL+"/v1/responses", strings.NewReader(string(body)))
			if err != nil {
				t.Fatal(err)
			}
			public.Header.Set("Authorization", "Bearer gateway-token")
			public.Header.Set("Content-Type", "application/json")
			public.Header.Set("X-Request-Id", requestID)
			public.Header.Set(compatibilityHeader, "allow")
			response, err := http.DefaultClient.Do(public)
			if err != nil {
				t.Fatal(err)
			}
			raw, err = io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil || response.Header.Get("X-Request-Id") != requestID {
				t.Fatalf("public correlation: err=%v request_id=%q", err, response.Header.Get("X-Request-Id"))
			}
			status = response.StatusCode
			if status != http.StatusOK {
				t.Fatalf("public stream status=%d body=%s", status, raw)
			}
			text, completed, failed := "", 0, 0
			var terminal map[string]any
			for _, line := range strings.Split(string(raw), "\n") {
				if !strings.HasPrefix(line, "data: {") {
					continue
				}
				var event map[string]any
				if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
					t.Fatal(err)
				}
				switch event["type"] {
				case "response.output_text.delta":
					text += event["delta"].(string)
				case "response.completed":
					completed++
					terminal = event["response"].(map[string]any)
				case "response.failed":
					failed++
					terminal = event["response"].(map[string]any)
				case "response.incomplete":
					t.Fatal("unexpected incomplete terminal")
				}
			}
			if text != "OK." || attempts.Load() != 2 {
				t.Fatalf("text=%q upstream attempts=%d", text, attempts.Load())
			}
			if failure {
				if completed != 0 || failed != 1 || terminal["status"] != "failed" || terminal["error"] == nil {
					t.Fatalf("error terminal: completed=%d failed=%d response=%+v", completed, failed, terminal)
				}
			} else {
				if completed != 1 || failed != 0 || terminal["status"] != "completed" || terminal["error"] != nil {
					t.Fatalf("success terminal: completed=%d failed=%d response=%+v", completed, failed, terminal)
				}
				usage := terminal["usage"].(map[string]any)
				if usage["input_tokens"] != float64(23) || usage["output_tokens"] != float64(3) || usage["total_tokens"] != float64(26) {
					t.Fatalf("reported terminal usage changed: %+v", usage)
				}
			}
			rows, _, err := iam.ListUsageEvents(iam.UsageEventFilter{RequestID: requestID})
			if err != nil || len(rows) != 1 {
				t.Fatalf("correlated ledger: err=%v rows=%+v", err, rows)
			}
			row := rows[0]
			if row.RequestID != requestID || row.Endpoint != "openai.responses" || row.Provider != "chat" || row.RequestedModel != "chat/fixture" || row.RoutedModel != "fixture" {
				t.Fatalf("ledger target/correlation: %+v", row)
			}
			if row.SourceUsage == nil || row.SourceUsage.SelectedAttempt != 0 || len(row.SourceUsage.Attempts) != 1 || row.SourceUsage.Attempts[0].Attempt != 1 {
				t.Fatalf("ledger source attempt: %+v", row.SourceUsage)
			}
			counts := row.SourceUsage.Attempts[0].Counts
			if failure {
				if row.StatusCode != 502 || row.ErrorCode != "upstream_stream" || counts["input_tokens"].Presence != "absent" || counts["output_tokens"].Presence != "absent" {
					t.Fatalf("failed ledger must not report invented source counts: %+v source=%+v", row, row.SourceUsage)
				}
			} else {
				if row.StatusCode != 200 || row.ErrorCode != "" || row.InputTokens != 23 || row.OutputTokens != 3 || row.SourceUsage.InputBasis != "reported" || row.SourceUsage.OutputBasis != "reported" {
					t.Fatalf("successful ledger: %+v", row)
				}
				for name, want := range map[string]int64{"input_tokens": 23, "output_tokens": 3, "total_tokens": 26, "cache_read_tokens": 3} {
					if got := counts[name]; got.Presence != "present" || got.Value != want {
						t.Fatalf("source %s=%+v want present/%d", name, got, want)
					}
				}
			}
		})
	}
}

func stage2TerminalFrames(mode string) []string {
	frames := []string{
		`{"id":"chatcmpl-stage2","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}`,
		`{"id":"chatcmpl-stage2","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"content":"."},"finish_reason":null}]}`,
	}
	finish := `{"id":"chatcmpl-stage2","object":"chat.completion.chunk","created":1,"model":"fixture","system_fingerprint":"fp_synthetic","service_tier":"default","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}`
	usage := `{"prompt_tokens":23,"completion_tokens":3,"total_tokens":26,"prompt_tokens_details":{"cached_tokens":3}}`
	tail := `{"id":"chatcmpl-stage2","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[],"usage":` + usage + `}`
	switch mode {
	case "usage-with-finish":
		return append(frames, strings.TrimSuffix(finish, "}")+`,"usage":`+usage+`}`)
	case "usage-before-finish":
		return append(frames, tail, finish)
	case "unknown-final":
		return append(frames, strings.TrimSuffix(finish, "}")+`,"future_state":{"opaque":"synthetic"}}`)
	case "opaque-final":
		return append(frames, `{"choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"synthetic"}]},"finish_reason":"stop"}]}`)
	case "source-error":
		return append(frames, `{"error":{"type":"synthetic_upstream_failure","code":"synthetic_error","message":"synthetic source failure"}}`)
	default:
		return append(frames, finish, tail)
	}
}
