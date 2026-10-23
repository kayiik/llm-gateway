package iam

import (
	"math"
	"testing"
)

func TestUsageRejectsInvalidValuesWithoutChangingCounters(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	ResetForTests()
	t.Cleanup(ResetForTests)
	p, _ := quotaPrincipal(t, KeyPolicy{})
	base := UsageEvent{ProjectID: p.ProjectID, PrincipalID: p.PrincipalID, KeyID: p.KeyID, InputTokens: 10, OutputTokens: 5, CostMicroUSD: 7, CreditsMilli: 9}
	if err := RecordUsageEvent(base); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		set  func(*UsageEvent)
	}{
		{"input", func(e *UsageEvent) { e.InputTokens = -1 }},
		{"output", func(e *UsageEvent) { e.OutputTokens = -1 }},
		{"cost", func(e *UsageEvent) { e.CostMicroUSD = -1 }},
		{"credits", func(e *UsageEvent) { e.CreditsMilli = -1 }},
		{"latency", func(e *UsageEvent) { e.LatencyMS = -1 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event := base
			tc.set(&event)
			if err := RecordUsageEvent(event); err == nil {
				t.Fatal("invalid usage was accepted")
			}
		})
	}
	db, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	var events int
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage_events`).Scan(&events); err != nil || events != 1 {
		t.Fatalf("events=%d err=%v, want only the valid event", events, err)
	}
	for _, table := range []string{"quota_counters", "project_quota_counters"} {
		var input, output, cost, credits int64
		if err := db.QueryRow(`SELECT input_tokens,output_tokens,cost_microusd,credits_milli FROM `+table+` WHERE period='day'`).Scan(&input, &output, &cost, &credits); err != nil {
			t.Fatal(err)
		}
		if input != 10 || output != 5 || cost != 7 || credits != 9 {
			t.Fatalf("%s counters=%d/%d/%d/%d", table, input, output, cost, credits)
		}
	}
}

func TestUsageCounterOverflowRollsBackTheEntireEvent(t *testing.T) {
	for _, table := range []string{"quota_counters", "project_quota_counters"} {
		for _, column := range []string{"input_tokens", "output_tokens", "cost_microusd", "credits_milli"} {
			t.Run(table+"/"+column, func(t *testing.T) {
				t.Setenv("LLMGW_STATE_DIR", t.TempDir())
				ResetForTests()
				t.Cleanup(ResetForTests)
				p, _ := quotaPrincipal(t, KeyPolicy{})
				event := UsageEvent{ProjectID: p.ProjectID, PrincipalID: p.PrincipalID, KeyID: p.KeyID}
				if err := RecordUsageEvent(event); err != nil {
					t.Fatal(err)
				}
				db, err := DB()
				if err != nil {
					t.Fatal(err)
				}
				if _, err := db.Exec(`UPDATE `+table+` SET `+column+`=? WHERE period='month'`, int64(math.MaxInt64)); err != nil {
					t.Fatal(err)
				}
				event.InputTokens, event.OutputTokens, event.CostMicroUSD, event.CreditsMilli = 1, 1, 1, 1
				if err := RecordUsageEvent(event); err == nil {
					t.Fatal("overflowing counter update was accepted")
				}
				var events, dayInput int
				if err := db.QueryRow(`SELECT COUNT(*) FROM usage_events`).Scan(&events); err != nil {
					t.Fatal(err)
				}
				if err := db.QueryRow(`SELECT input_tokens FROM quota_counters WHERE period='day'`).Scan(&dayInput); err != nil {
					t.Fatal(err)
				}
				if events != 1 || dayInput != 0 {
					t.Fatalf("partially settled event: events=%d daily input=%d", events, dayInput)
				}
			})
		}
	}
}

func TestUsageCounterTotalTokensCannotOverflow(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	ResetForTests()
	t.Cleanup(ResetForTests)
	p, _ := quotaPrincipal(t, KeyPolicy{})
	event := UsageEvent{ProjectID: p.ProjectID, KeyID: p.KeyID}
	if err := RecordUsageEvent(event); err != nil {
		t.Fatal(err)
	}
	db, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE quota_counters SET input_tokens=?`, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	event.OutputTokens = 1
	if err := RecordUsageEvent(event); err == nil {
		t.Fatal("combined input/output overflow was accepted")
	}
}

func TestUsageAcceptsZeroAndExactIntegerLimits(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	ResetForTests()
	t.Cleanup(ResetForTests)
	p, _ := quotaPrincipal(t, KeyPolicy{})
	event := UsageEvent{ProjectID: p.ProjectID, KeyID: p.KeyID}
	if err := RecordUsageEvent(event); err != nil {
		t.Fatal(err)
	}
	event.CostMicroUSD, event.CreditsMilli = math.MaxInt64, math.MaxInt64
	if err := RecordUsageEvent(event); err != nil {
		t.Fatalf("exact integer limit: %v", err)
	}
	event.CostMicroUSD, event.CreditsMilli = 0, 0
	if err := RecordUsageEvent(event); err != nil {
		t.Fatalf("zero at integer limit: %v", err)
	}
}
