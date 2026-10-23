package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"llmgw/internal/iam"

	translate "github.com/kayiik/llm-translate"
	core "github.com/kayiik/llmgw-core"
)

type fixedSourceUsage struct {
	observation core.SourceUsageObservation
	history     core.SourceUsageHistory
	unavailable bool
}

func (s fixedSourceUsage) SourceUsage() (core.SourceUsageObservation, bool) {
	return s.observation, !s.unavailable
}
func (s fixedSourceUsage) SourceUsageHistory() core.SourceUsageHistory { return s.history }

func TestSourceUsageHistorySurvivesUnavailableLatestReporter(t *testing.T) {
	usage := translate.ObserveUsage(translate.UsageDialectChat, map[string]any{"prompt_tokens": 11, "completion_tokens": 7}, translate.CompletionFailed)
	value := fixedSourceUsage{unavailable: true, history: core.SourceUsageHistory{Attempts: []core.SourceUsageObservation{{API: core.UpstreamAPIChatCompletions, Instance: "provider-a", Model: "model-a", Attempt: 1, Usage: usage}}}}
	input, output, evidence, target := sourceUsageSnapshot(value, 3, 2, "legacy", "legacy")
	if evidence == nil {
		t.Fatal("later pre-native failure discarded earlier actual native history")
	}
	if input != 3 || output != 2 || target != nil || !evidence.SelectionUnavailable || evidence.SelectedAttempt != -1 || len(evidence.Attempts) != 1 || evidence.Attempts[0].Provider != "provider-a" || evidence.Attempts[0].Counts["input_tokens"].Value != 11 {
		t.Fatalf("history-only evidence changed selected-source policy: %d/%d target=%+v evidence=%+v", input, output, target, evidence)
	}
}

func TestSourceUsagePreservesZeroAbsenceAndIncompleteInput(t *testing.T) {
	for _, tc := range []struct {
		name       string
		dialect    translate.UsageDialect
		usage      any
		input, out int
		incomplete bool
	}{
		{"reported zero", translate.UsageDialectChat, map[string]any{"prompt_tokens": 0, "completion_tokens": 0}, 0, 0, false},
		{"absent", translate.UsageDialectChat, nil, 25, 9, false},
		{"incomplete inclusive", translate.UsageDialectMessages, map[string]any{"input_tokens": 11, "output_tokens": 7}, 11, 7, true},
		{"cache once", translate.UsageDialectMessages, map[string]any{"input_tokens": 7, "cache_read_input_tokens": 11, "cache_creation_input_tokens": 13, "output_tokens": 5}, 31, 5, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			observation := core.SourceUsageObservation{API: core.UpstreamAPIChatCompletions, Instance: "provider-a", Model: "model-a", Attempt: 1,
				Usage: translate.ObserveUsage(tc.dialect, tc.usage, translate.CompletionComplete)}
			input, output, evidence, target := sourceUsageSnapshot(fixedSourceUsage{observation: observation}, 25, 9, "estimated", "estimated")
			if input != tc.input || output != tc.out || evidence == nil || evidence.Invalid || evidence.InputIncomplete != tc.incomplete || target.Provider != "provider-a" || target.Model != "model-a" {
				t.Fatalf("input=%d output=%d evidence=%+v target=%+v", input, output, evidence, target)
			}
			if tc.name == "reported zero" && evidence.OutputBasis != "reported" {
				t.Fatalf("reported zero became %s", evidence.OutputBasis)
			}
			if tc.incomplete && evidence.Attempts[0].Counts["input_tokens"].Presence != "absent" {
				t.Fatal("incomplete inclusive input became measured zero")
			}
		})
	}
}

func TestSourceUsageEvidenceIsBoundedAndExcludesProviderPayloads(t *testing.T) {
	usage := translate.ObserveUsage(translate.UsageDialectChat, map[string]any{"prompt_tokens": 1, "completion_tokens": 2, "api_key": "fixture-secret-not-for-ledger"}, translate.CompletionComplete)
	observation := core.SourceUsageObservation{Instance: "provider-b", Model: "model-b", Attempt: 2, Usage: usage}
	history := core.SourceUsageHistory{}
	for attempt := uint64(1); attempt <= 12; attempt++ {
		history.Attempts = append(history.Attempts, core.SourceUsageObservation{Instance: "provider-a", Model: "model-a", Attempt: attempt, Usage: usage})
	}
	history.Attempts[len(history.Attempts)-1] = observation
	_, _, evidence, _ := sourceUsageSnapshot(fixedSourceUsage{observation: observation, history: history}, 0, 0, "unavailable", "unavailable")
	encoded, err := json.Marshal(evidence)
	if err != nil {
		t.Fatal(err)
	}
	if !evidence.HistoryTruncated || len(evidence.Attempts) != 8 || evidence.Attempts[7].Provider != "provider-b" || evidence.Attempts[7].Model != "model-b" || strings.Contains(string(encoded), "fixture-secret") || strings.Contains(string(encoded), "api_key") {
		t.Fatalf("unbounded or unsafe evidence: %s", encoded)
	}
}

func TestSourceUsageInvalidCountsCannotBecomeAnEstimate(t *testing.T) {
	usage := translate.ObserveUsage(translate.UsageDialectChat, map[string]any{"prompt_tokens": -1, "completion_tokens": 7}, translate.CompletionComplete)
	input, output, evidence, _ := sourceUsageSnapshot(fixedSourceUsage{observation: core.SourceUsageObservation{Usage: usage}}, 100, 200, "estimated", "estimated")
	if input != 0 || output != 0 || !evidence.Invalid || evidence.Attempts[0].Counts["input_tokens"].Presence != "invalid" {
		t.Fatalf("invalid source was settled: %d/%d %+v", input, output, evidence)
	}
}

func TestSourceUsagePartialCountRemainsAnExplicitLowerBound(t *testing.T) {
	usage := translate.ObserveUsage(translate.UsageDialectMessages, map[string]any{"input_tokens": 11, "output_tokens": 1}, translate.CompletionFailed)
	_, output, evidence, _ := sourceUsageSnapshot(fixedSourceUsage{observation: core.SourceUsageObservation{Usage: usage}}, 10, 8, "estimated", "estimated")
	if output != 1 || !evidence.OutputIncomplete || evidence.OutputBasis != "reported_partial" || evidence.Attempts[0].Quality != "failed" {
		t.Fatalf("partial source count lost its qualification: %d %+v", output, evidence)
	}
}

func TestSourceUsageGoogleCandidateSubtotalRemainsQualified(t *testing.T) {
	usage := translate.ObserveUsage(translate.UsageDialectChat, map[string]any{"prompt_tokens": 11, "completion_tokens": 5, "total_tokens": 16}, translate.CompletionComplete)
	usage.OutputTokens.Provenance = translate.UsageDerived
	usage.OutputTokens.Path = "candidatesTokenCount (lower_bound; thoughtsTokenCount absent)"
	input, output, evidence, _ := sourceUsageSnapshot(fixedSourceUsage{observation: core.SourceUsageObservation{API: core.UpstreamAPIGoogleGenerateContent, Usage: usage}}, 10, 3, "estimated", "estimated")
	if input != 11 || output != 5 || !evidence.OutputIncomplete || evidence.OutputBasis != "derived_incomplete" || evidence.Attempts[0].Counts["reasoning_tokens"].Presence != "absent" {
		t.Fatalf("Google source subtotal was estimated or overstated: %d/%d %+v", input, output, evidence)
	}
}

func TestSourceUsageLargeCountsStayExact(t *testing.T) {
	usage := translate.ObserveUsage(translate.UsageDialectChat, map[string]any{"prompt_tokens": json.Number("9007199254740993"), "completion_tokens": 2}, translate.CompletionComplete)
	input, output, evidence, _ := sourceUsageSnapshot(fixedSourceUsage{observation: core.SourceUsageObservation{Usage: usage}}, 0, 0, "unavailable", "unavailable")
	if strconv.IntSize == 64 {
		if int64(input) != 9007199254740993 || output != 2 || evidence.Invalid {
			t.Fatalf("source count rounded: %d/%d %+v", input, output, evidence)
		}
	} else if !evidence.Invalid {
		t.Fatal("unrepresentable legacy counter was accepted")
	}
	if evidence.Attempts[0].Counts["input_tokens"].Value != 9007199254740993 {
		t.Fatal("durable source evidence lost precision")
	}
}

func TestSourceUsageReportedZeroPersistsForInvokeAndStream(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprint(stream), func(t *testing.T) {
			handler := setupAPISmokeFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if stream {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"nonempty output\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0,\"total_tokens\":0}}\n\ndata: [DONE]\n\n")
					return
				}
				_, _ = fmt.Fprint(w, `{"choices":[{"index":0,"message":{"role":"assistant","content":"nonempty output"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}`)
			}))
			response := apiSmokeRequest(handler, "/v1/chat/completions", map[string]any{"model": "fixture/model", "stream": stream, "messages": []any{map[string]any{"role": "user", "content": "nonempty prompt"}}})
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			rows, _, err := iam.ListUsageEvents(iam.UsageEventFilter{})
			if err != nil || len(rows) != 1 || rows[0].SourceUsage == nil || rows[0].InputTokens != 0 || rows[0].OutputTokens != 0 {
				t.Fatalf("reported zero was estimated: rows=%+v error=%v", rows, err)
			}
			evidence := rows[0].SourceUsage
			if evidence.InputBasis != "reported" || evidence.OutputBasis != "reported" || evidence.Attempts[evidence.SelectedAttempt].Counts["output_tokens"].Presence != "present" {
				t.Fatalf("reported zero lost presence/provenance: %+v", evidence)
			}
		})
	}
}

func TestSourceUsageRetainedAfterResponseFidelityFailure(t *testing.T) {
	var calls atomic.Int32
	handler := setupAPISmokeFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = fmt.Fprint(w, `{"model":"reported-model","choices":[{"index":0,"message":{"role":"assistant","content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18},"unassessed_response_control":{"opaque":"fixture-state"}}`)
	}))
	response := apiSmokeRequestWithCompatibility(handler, "/v1/messages", map[string]any{"model": "fixture/model", "max_tokens": 8, "messages": []any{map[string]any{"role": "user", "content": "hi"}}}, "allow")
	if response.Code != http.StatusBadRequest || calls.Load() != 1 {
		t.Fatalf("fidelity failure status=%d calls=%d body=%s", response.Code, calls.Load(), response.Body.String())
	}
	rows, _, err := iam.ListUsageEvents(iam.UsageEventFilter{})
	if err != nil || len(rows) != 1 || rows[0].SourceUsage == nil || rows[0].InputTokens != 11 || rows[0].OutputTokens != 7 || rows[0].Provider != "fixture" || rows[0].RoutedModel != "model" {
		t.Fatalf("paid source evidence lost: rows=%+v error=%v", rows, err)
	}
	selected := rows[0].SourceUsage.Attempts[rows[0].SourceUsage.SelectedAttempt]
	if selected.Quality != "complete" || selected.Provider != "fixture" || selected.Model != "model" {
		t.Fatalf("source completion confused with delivery failure: %+v", selected)
	}
}

func TestSourceUsageInvalidProviderEvidenceIsRecordedWithoutCharge(t *testing.T) {
	handler := setupAPISmokeFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"choices":[{"index":0,"message":{"role":"assistant","content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":-1,"completion_tokens":7,"total_tokens":6,"api_key":"fixture-secret-not-for-ledger"}}`)
	}))
	response := apiSmokeRequest(handler, "/v1/chat/completions", map[string]any{"model": "fixture/model", "messages": []any{map[string]any{"role": "user", "content": "hi"}}})
	if response.Code != http.StatusOK {
		t.Fatalf("native wire changed: status=%d body=%s", response.Code, response.Body.String())
	}
	rows, _, err := iam.ListUsageEvents(iam.UsageEventFilter{})
	if err != nil || len(rows) != 1 || rows[0].SourceUsage == nil || !rows[0].SourceUsage.Invalid || rows[0].InputTokens != 0 || rows[0].OutputTokens != 0 || rows[0].CostMicroUSD != 0 || rows[0].CreditsMilli != 0 {
		t.Fatalf("invalid source was lost or charged: rows=%+v error=%v", rows, err)
	}
	encoded, err := json.Marshal(rows[0].SourceUsage)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "fixture-secret") || strings.Contains(string(encoded), "api_key") {
		t.Fatalf("provider payload entered durable evidence: %s", encoded)
	}
}
