package iam

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/config"
)

func TestTargetQuotaAtomicAdmissionRollbackAndWindows(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	ResetForTests()
	t.Cleanup(ResetForTests)
	now := time.Date(2026, 8, 10, 1, 2, 3, 0, time.UTC)
	limits := &config.ProviderUsageLimits{TargetUsageLimits: config.TargetUsageLimits{RPM: 7}, Models: map[string]config.TargetUsageLimits{"m": {RPM: 3}}}
	var admitted atomic.Int32
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := CheckAndConsumeTargetRequest(t.Context(), "p", "m", limits, now)
			var exceeded *QuotaExceeded
			if err == nil {
				admitted.Add(1)
			} else if !errors.As(err, &exceeded) {
				t.Errorf("unexpected admission error: %v", err)
			}
		}()
	}
	wg.Wait()
	if admitted.Load() != 3 {
		t.Fatalf("admitted=%d", admitted.Load())
	}
	// Rejected model attempts must not consume the remaining provider slots.
	for range 4 {
		if err := CheckAndConsumeTargetRequest(t.Context(), "p", "other", limits, now); err != nil {
			t.Fatal(err)
		}
	}
	if err := CheckAndConsumeTargetRequest(t.Context(), "p", "other", limits, now); err == nil {
		t.Fatal("provider cap bypassed")
	}
	ResetForTests()
	if err := CheckAndConsumeTargetRequest(t.Context(), "p", "m", limits, now); err == nil {
		t.Fatal("restart lost counters")
	}
	if err := CheckAndConsumeTargetRequest(t.Context(), "p", "m", limits, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
}

func TestTargetQuotaObservedTokenOverageAndAdmissionWindow(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	ResetForTests()
	t.Cleanup(ResetForTests)
	now := time.Date(2026, 8, 31, 23, 59, 50, 0, time.UTC)
	limits := &config.ProviderUsageLimits{TargetUsageLimits: config.TargetUsageLimits{DailyTokens: 10, MonthlyTokens: 20}}
	// Two inflight responses can cross the threshold; no token reservation.
	for range 2 {
		if err := CheckAndConsumeTargetRequest(t.Context(), "p", "m", limits, now); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := SettleTargetTokens("p", "m", now, 8); err != nil {
			t.Fatal(err)
		}
	}
	var exceeded *QuotaExceeded
	if err := CheckAndConsumeTargetRequest(t.Context(), "p", "m", limits, now); !errors.As(err, &exceeded) || exceeded.Field != "daily_tokens" {
		t.Fatalf("expected observed threshold, got %v", err)
	}
	if err := CheckAndConsumeTargetRequest(t.Context(), "p", "m", limits, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := SettleTargetTokens("p", "m", now.Add(time.Minute), 0); err != nil {
		t.Fatal(err)
	}
	if _, err := PruneOperationalHistory(now.Add(time.Minute), DefaultRetentionPolicy()); err != nil {
		t.Fatal(err)
	}
	if err := SettleTargetTokens("p", "m", now, 5); err != nil {
		t.Fatal(err)
	}
	if err := CheckAndConsumeTargetRequest(t.Context(), "p", "m", limits, now.Add(time.Minute)); err != nil {
		t.Fatalf("late old-window settlement affected new month: %v", err)
	}
}
