package iam

import (
	"errors"
	"testing"
	"time"
)

func TestDeleteProjectRequiresDisabledAndIsTerminal(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	ResetForTests()
	t.Cleanup(ResetForTests)
	project, err := CreateProject("retired", "Retired")
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := DeleteProject(project.ID, AuditEvent{}); changed || !errors.Is(err, ErrProjectNotDisabled) {
		t.Fatalf("delete active project: changed=%v err=%v", changed, err)
	}
	if changed, err := DeleteProject("missing", AuditEvent{}); changed || !errors.Is(err, ErrProjectNotFound) {
		t.Fatalf("delete unknown project: changed=%v err=%v", changed, err)
	}
	if err := SetProjectStatus(project.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	if got, found, err := ProjectByID(project.ID); err != nil || !found || got.Status != "disabled" {
		t.Fatalf("disabled project before removal: %+v found=%v err=%v", got, found, err)
	}
	for i, wantChange := range []bool{true, false} {
		if changed, err := DeleteProject(project.ID, AuditEvent{}); err != nil || changed != wantChange {
			t.Fatalf("delete %d: changed=%v err=%v", i, changed, err)
		}
	}
	if _, found, err := ProjectByID(project.ID); found || err != nil {
		t.Fatalf("removed project found by id: %v err=%v", found, err)
	}
	if _, found, err := ProjectBySlug(project.Slug); found || err != nil {
		t.Fatalf("removed project found by slug: %v err=%v", found, err)
	}
	if projects, err := ListProjects(); err != nil || len(projects) != 0 {
		t.Fatalf("projects after removal: %+v err=%v", projects, err)
	}
	if err := SetProjectStatus(project.ID, "active"); !errors.Is(err, ErrProjectNotFound) {
		t.Fatalf("reactivate removed project: %v", err)
	}
	if _, err := EnsureProject(project.Slug, "Replacement"); err == nil {
		t.Fatal("reused a removed project's slug")
	}
}

func TestDeleteProjectPreservesHistoryAndOtherProjectsAccess(t *testing.T) {
	setupCredentialTest(t)
	project := must(CreateProject("retiring", "Retiring team"))
	other := must(CreateProject("continuing", "Continuing team"))
	member := must(CreatePrincipal("service", "worker", "", "Worker"))
	credential := must(PutGatewayProviderCredential("example", "api_key", "fixture"))
	for _, p := range []Project{project, other} {
		if err := SetMembership(p.ID, member.ID, "member"); err != nil {
			t.Fatal(err)
		}
		must(SetProviderCredentialBinding(p.ID, "example", "service", credential.ID))
	}
	key := must(IssueKey(KeyCreate{ProjectID: project.ID, PrincipalID: member.ID, Name: "Historical key"}))
	kept := must(IssueKey(KeyCreate{ProjectID: other.ID, PrincipalID: member.ID}))
	must(SetProjectPolicy(project.ID, KeyPolicy{DailyRequests: 10}))
	if err := RecordUsageEvent(UsageEvent{RequestID: "recorded", Endpoint: "openai.chat",
		Timestamp: time.Now().Unix(), StatusCode: 200, ProjectID: project.ID, PrincipalID: member.ID, KeyID: key.ID}); err != nil {
		t.Fatal(err)
	}
	if err := RecordAudit(AuditEvent{Action: "fixture.usage", TargetType: "project", TargetID: project.ID, ActorKeyID: key.ID}); err != nil {
		t.Fatal(err)
	}
	if err := SetProjectStatus(project.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	if keys := must(ListAPIKeys(project.ID)); len(keys) != 1 || keys[0].ID != key.ID {
		t.Fatalf("disabled project's keys before removal: %+v", keys)
	}
	if bindings := must(ListProviderCredentialBindings(project.ID)); len(bindings) != 1 || bindings[0].CredentialID != credential.ID {
		t.Fatalf("disabled project's bindings before removal: %+v", bindings)
	}
	if changed, err := DeleteProject(project.ID, AuditEvent{ActorPrincipalID: member.ID}); err != nil || !changed {
		t.Fatalf("delete: changed=%v err=%v", changed, err)
	}

	events, _, err := ListUsageEvents(UsageEventFilter{ProjectID: project.ID, KeyID: key.ID})
	if err != nil || len(events) != 1 || events[0].ProjectID != project.ID || events[0].ProjectName != project.Name || events[0].KeyID != key.ID || events[0].KeyName != key.Name {
		t.Fatalf("usage attribution after removal: %+v err=%v", events, err)
	}
	stats := must(UsageStatsFor(UsageTimeSeriesFilter{ProjectID: project.ID}))
	groups := stats["groups"].(map[string][]UsageGroup)["project"]
	if len(groups) != 1 || groups[0].ProjectID != project.ID || groups[0].ProjectName != project.Name {
		t.Fatalf("project usage after removal: %+v", groups)
	}
	audit, _, err := ListAuditFiltered(AuditFilter{TargetID: project.ID, Actor: key.ID})
	if err != nil || len(audit) != 1 || audit[0].ActorKeyID != key.ID || audit[0].TargetID != project.ID {
		t.Fatalf("audit attribution after removal: %+v err=%v", audit, err)
	}
	if _, found, err := ResolveAPIKey(key.Token); err != nil || found {
		t.Errorf("removed project's key authenticated: %v err=%v", found, err)
	}
	if _, found, err := ResolveAPIKey(kept.Token); err != nil || !found {
		t.Errorf("remaining project's key failed authentication: %v err=%v", found, err)
	}
	if _, found, err := APIKeyByID(key.ID); err != nil || found {
		t.Errorf("removed project's key accessible by ID: %v err=%v", found, err)
	}
	if _, found, err := RevealAPIKey(key.ID); err != nil || found {
		t.Errorf("removed project's key revealable: %v err=%v", found, err)
	}
	if keys, count, err := ListAPIKeysPage(KeyListFilter{Status: "all"}); err != nil || count != 1 || len(keys) != 1 || keys[0].ID != kept.ID {
		t.Errorf("listed operational keys: %+v count=%d err=%v", keys, count, err)
	}
	if counts, err := CountIdentities(); err != nil || counts.Keys != 1 {
		t.Errorf("operational key count %d err=%v", counts.Keys, err)
	}
	if _, found, err := MembershipRole(project.ID, member.ID); err != nil || found {
		t.Errorf("removed project granted a role: %v err=%v", found, err)
	}
	if memberships, err := ListPrincipalMemberships(member.ID); err != nil || len(memberships) != 1 || memberships[0].ProjectID != other.ID {
		t.Errorf("listed memberships: %+v err=%v", memberships, err)
	}
	if _, count, err := ListPrincipalsPage(PrincipalListFilter{ProjectID: project.ID}); err != nil || count != 0 {
		t.Errorf("principals selected by removed project: %d err=%v", count, err)
	}
	if bindings, err := ListProviderCredentialBindings(""); err != nil || len(bindings) != 1 || bindings[0].ProjectID != other.ID || bindings[0].CredentialID != credential.ID {
		t.Errorf("listed bindings: %+v err=%v", bindings, err)
	}
	if _, _, ok, err := ResolveProviderCredentialSecretWithObservation(requestPrincipal(member, other), "example"); err != nil || !ok {
		t.Errorf("remaining project's shared credential inaccessible: found=%v err=%v", ok, err)
	}
	if policy, err := GetProjectPolicy(project.ID); err != nil || policy.DailyRequests != 0 {
		t.Errorf("retrieved removed project's policy: %+v err=%v", policy, err)
	}
	if err := SetMembership(project.ID, member.ID, "owner"); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("change removed membership: %v", err)
	}
	if err := RemoveMembership(project.ID, member.ID); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("remove retained membership: %v", err)
	}
	if _, err := SetProjectPolicy(project.ID, KeyPolicy{RPM: 77}); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("change removed project policy: %v", err)
	}
	if _, err := IssueKey(KeyCreate{ProjectID: project.ID, PrincipalID: member.ID}); err == nil {
		t.Error("issued a key for a removed project")
	}
	if err := CheckAndConsumeProjectRequest(project.ID, time.Now()); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("reserved request quota for a removed project: %v", err)
	}
	if err := SetProviderCredentialBindingStatus(project.ID, "example", "service", "disabled"); err == nil {
		t.Error("changed removed project binding")
	}
}

func TestDeletingProjectStopsAlertsWithoutLosingOutstandingUsage(t *testing.T) {
	setupCredentialTest(t)
	project := must(CreateProject("ending", "Ending"))
	other := must(CreateProject("remaining", "Remaining"))
	member := must(CreatePrincipal("service", "alerts-worker", "", "Alerts worker"))
	now := time.Now().UTC()
	issue := func(p Project) IssuedKey {
		t.Helper()
		if err := SetMembership(p.ID, member.ID, "member"); err != nil {
			t.Fatal(err)
		}
		return must(IssueKey(KeyCreate{ProjectID: p.ID, PrincipalID: member.ID,
			ExpiresAt: now.Add(24 * time.Hour).Unix(), Policy: KeyPolicy{DailyInputTokens: 10}}))
	}
	old := issue(project)
	kept := issue(other)
	local := must(CreateAlertRule(AlertRule{ProjectID: project.ID, Kind: "key_expiry", Period: "day", Threshold: 2}))
	global := must(CreateAlertRule(AlertRule{Kind: "key_expiry", Period: "day", Threshold: 2}))
	must(CreateAlertRule(AlertRule{ProjectID: project.ID, Kind: "quota_usage", Metric: "input_tokens", Period: "day", Threshold: 50}))
	must(CreateAlertRule(AlertRule{Kind: "quota_usage", Metric: "input_tokens", Period: "day", Threshold: 50}))
	must(SetProjectPolicy(project.ID, KeyPolicy{DailyInputTokens: 10}))
	if err := SetProjectStatus(project.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	must(DeleteProject(project.ID, AuditEvent{}))
	if rules, err := ListAlertRules(); err != nil || len(rules) != 2 {
		t.Errorf("visible rules: %+v err=%v", rules, err)
	}
	if _, err := CreateAlertRule(local); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("new alert on removed project: %v", err)
	}
	if err := SetAlertRuleEnabled(local.ID, false); err == nil {
		t.Error("a retained alert was changed")
	}
	if err := DeleteAlertRule(local.ID); err == nil {
		t.Error("a retained alert was deleted")
	}
	if err := RecordUsageEvent(UsageEvent{RequestID: "complete-in-flight", ProjectID: project.ID,
		KeyID: old.ID, PrincipalID: member.ID, StatusCode: 200, InputTokens: 8}); err != nil {
		t.Fatal(err)
	}
	if count, err := EvaluateScheduledAlerts(now); err != nil || count != 1 {
		t.Errorf("scheduled alerts: count=%d err=%v", count, err)
	}
	pending := must(PendingOutbox(10))
	if len(pending) != 1 || pending[0].Payload["key_id"] != kept.ID || pending[0].Payload["rule_id"] != global.ID {
		t.Errorf("expected a single continuing project's expiry notification: %+v", pending)
	}
}

func TestConcurrentProjectRemovalChangesOnlyOnce(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	ResetForTests()
	t.Cleanup(ResetForTests)
	project := must(CreateProject("concurrent", "Concurrent"))
	if err := SetProjectStatus(project.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		changed bool
		err     error
	}
	const attempts = 8
	start := make(chan struct{})
	results := make(chan outcome, attempts)
	for range attempts {
		go func() {
			<-start
			changed, err := DeleteProject(project.ID, AuditEvent{})
			results <- outcome{changed, err}
		}()
	}
	close(start)
	changes := 0
	for range attempts {
		got := <-results
		if got.err != nil {
			t.Fatal(got.err)
		}
		if got.changed {
			changes++
		}
	}
	if changes != 1 {
		t.Fatalf("removal changed the project %d times, want one", changes)
	}
	events, _, err := ListAuditFiltered(AuditFilter{Action: "project.delete", TargetID: project.ID})
	if err != nil || len(events) != 1 {
		t.Fatalf("concurrent project delete audit events=%d err=%v", len(events), err)
	}
}
