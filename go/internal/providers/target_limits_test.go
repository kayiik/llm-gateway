package providers

import (
	"context"
	"testing"
	"time"

	translate "github.com/kayiik/llm-translate"
	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/config"
	"llmgw/internal/iam"
)

func TestTargetLimitsSettleEveryAttemptBeyondDiagnosticHistory(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	iam.ResetForTests()
	t.Cleanup(iam.ResetForTests)
	collector := core.NewSourceUsageCollectorFor(core.Target{Provider: "p", Model: "m"})
	ctx := core.WithSourceUsageCollector(t.Context(), collector)
	limits := &config.ProviderUsageLimits{TargetUsageLimits: config.TargetUsageLimits{DailyTokens: 1000}}
	for range 70 {
		call := core.NewPreparedCall(core.CallDescription{Mode: core.CallModeInvoke, Ingress: core.ModelSurfaceChatCompletions, UpstreamAPI: core.UpstreamAPIChatCompletions, Model: "m", Assessment: core.CallAssessment{Feasibility: core.SupportSupported}}, func(ctx context.Context, _ *core.Credential) (core.Response, error) {
			record := core.BeginSourceUsage(ctx, core.UpstreamAPIChatCompletions, translate.UsageDialectChat)
			record.Merge(map[string]any{"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3})
			return core.Response{}, nil
		}, nil)
		if _, err := limitedPreparedCall(call, "p", "m", limits).Invoke(ctx, nil); err != nil {
			t.Fatal(err)
		}
	}
	db, err := iam.DB()
	if err != nil {
		t.Fatal(err)
	}
	var requests, tokens int64
	if err := db.QueryRow(`SELECT requests,observed_tokens FROM target_quota_counters WHERE provider_id='p' AND model='m' AND period='day'`).Scan(&requests, &tokens); err != nil {
		t.Fatal(err)
	}
	if requests != 70 || tokens != 210 {
		t.Fatalf("requests=%d tokens=%d", requests, tokens)
	}
	if len(collector.SourceUsageHistory().Attempts) >= 70 {
		t.Fatal("fixture did not exercise diagnostic truncation")
	}
}

func TestTargetLimitsUnknownInvalidExplicitZeroAndErrorDisposition(t *testing.T) {
	for _, tc := range []struct {
		name  string
		raw   map[string]any
		count int64
		known bool
	}{
		{"unknown", nil, 0, false},
		{"explicit zero", map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}, 0, true},
		{"partial", map[string]any{"prompt_tokens": 7}, 7, true},
		{"total only", map[string]any{"total_tokens": 100}, 100, true},
		{"total with partial breakdown", map[string]any{"prompt_tokens": 7, "total_tokens": 100}, 100, true},
		{"invalid", map[string]any{"prompt_tokens": 7, "completion_tokens": -2}, 0, false},
		{"explicit total not additive", map[string]any{"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}, 10, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			collector := core.NewSourceUsageCollectorFor(core.Target{Provider: "p", Model: "m"})
			record := core.BeginSourceUsage(core.WithSourceUsageCollector(t.Context(), collector), core.UpstreamAPIChatCompletions, translate.UsageDialectChat)
			if tc.raw != nil {
				record.Merge(tc.raw)
			}
			observation, _ := record.SourceUsage()
			count, known := targetObservedTokens(observation)
			if count != tc.count || known != tc.known {
				t.Fatalf("count=%d known=%v", count, known)
			}
		})
	}
	err := targetCapacityError(&iam.QuotaExceeded{Scope: "provider", Field: "rpm", Metric: "provider rpm", Limit: 1, Reset: time.Now().Add(time.Minute)})
	if !IsInvocation(err) || UpstreamStatus(err) != 429 || !InvocationFailoverEligible(err) || InvocationRetryable(err) || InvocationCircuitFailure(err) || !preparedNonHealth(err) {
		t.Fatalf("wrong local refusal disposition: %v %+v", err, core.ClassifyError(err))
	}
	if c := core.ClassifyError(err); !c.Local || c.Retryable || c.CircuitFailure || !c.FailoverEligible {
		t.Fatalf("core disagrees: %+v", c)
	}
}
