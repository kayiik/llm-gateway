package iam

import "testing"

func TestUsageEvidenceRoundTripKeepsZeroAndOldRowsDistinct(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	ResetForTests()
	t.Cleanup(ResetForTests)
	if err := RecordUsageEvent(UsageEvent{RequestID: "legacy-row", Endpoint: "openai.chat", StatusCode: 200}); err != nil {
		t.Fatal(err)
	}
	evidence := &UsageEvidence{Version: 1, InputBasis: "reported", OutputBasis: "estimated", Attempts: []UsageSource{{API: "chat_completions", Provider: "provider-a", Model: "model-a", Attempt: 1, Quality: "complete", Counts: map[string]UsageSourceCount{
		"input_tokens":  {Presence: "present", Provenance: "reported", Value: 0},
		"output_tokens": {Presence: "absent", Provenance: "reported"},
	}}}}
	if err := RecordUsageEvent(UsageEvent{RequestID: "observed-row", Endpoint: "openai.chat", StatusCode: 200, OutputTokens: 2, SourceUsage: evidence}); err != nil {
		t.Fatal(err)
	}
	ResetForTests()
	rows, _, err := ListUsageEvents(UsageEventFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].SourceUsage == nil || rows[1].SourceUsage != nil {
		t.Fatalf("old/source rows changed: %+v", rows)
	}
	counts := rows[0].SourceUsage.Attempts[0].Counts
	if counts["input_tokens"].Presence != "present" || counts["input_tokens"].Value != 0 || counts["output_tokens"].Presence != "absent" || rows[0].OutputTokens != 2 {
		t.Fatalf("source presence lost after reopen: %+v", rows[0])
	}
}

func TestInvalidUsageEvidenceIsRetainedWithoutSettlement(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	ResetForTests()
	t.Cleanup(ResetForTests)
	principal, _ := quotaPrincipal(t, KeyPolicy{})
	event := UsageEvent{RequestID: "invalid-source", Endpoint: "openai.chat", StatusCode: 200, ProjectID: principal.ProjectID, PrincipalID: principal.PrincipalID, KeyID: principal.KeyID,
		SourceUsage: &UsageEvidence{Version: 1, Invalid: true, Attempts: []UsageSource{{API: "chat_completions", Counts: map[string]UsageSourceCount{"input_tokens": {Presence: "invalid", Provenance: "reported"}}}}}}
	if err := RecordUsageEvent(event); err != nil {
		t.Fatal(err)
	}
	db, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"quota_counters", "project_quota_counters"} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("invalid source settled %s: count=%d error=%v", table, count, err)
		}
	}
	rows, _, err := ListUsageEvents(UsageEventFilter{})
	if err != nil || len(rows) != 1 || rows[0].SourceUsage == nil || !rows[0].SourceUsage.Invalid {
		t.Fatalf("invalid evidence was lost: rows=%+v error=%v", rows, err)
	}
	event.RequestID, event.InputTokens = "cannot-settle", 1
	if err := RecordUsageEvent(event); err == nil {
		t.Fatal("invalid source was allowed to settle a counter")
	}
}

func TestUsageEvidenceRetainsHistoryWithoutInventingSelectedSource(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	ResetForTests()
	t.Cleanup(ResetForTests)
	evidence := &UsageEvidence{Version: 1, InputBasis: "unavailable", OutputBasis: "unavailable", SelectedAttempt: -1, SelectionUnavailable: true,
		Attempts: []UsageSource{{API: "chat_completions", Provider: "provider-a", Model: "model-a", Attempt: 1, Quality: "failed", Counts: map[string]UsageSourceCount{"input_tokens": {Value: 11, Presence: "present", Provenance: "reported"}}}}}
	if err := RecordUsageEvent(UsageEvent{RequestID: "earlier-native", Endpoint: "openai.chat", StatusCode: 502, SourceUsage: evidence}); err != nil {
		t.Fatal(err)
	}
	rows, _, err := ListUsageEvents(UsageEventFilter{})
	if err != nil || len(rows) != 1 || rows[0].SourceUsage == nil {
		t.Fatalf("history-only record missing: rows=%+v error=%v", rows, err)
	}
	stored := rows[0].SourceUsage
	if !stored.SelectionUnavailable || stored.SelectedAttempt != -1 || stored.Attempts[0].Provider != "provider-a" || stored.Attempts[0].Counts["input_tokens"].Value != 11 || rows[0].InputTokens != 0 || rows[0].Provider != "" {
		t.Fatalf("history was dropped or misattributed as selected: %+v", rows[0])
	}
}
