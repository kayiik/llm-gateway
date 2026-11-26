package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"llmgw/internal/config"
	"llmgw/internal/iam"
)

func TestAdminDeletesOnlyDisabledProjects(t *testing.T) {
	env := newCredentialTestEnvWith(t, nil)
	defer env.server.Close()
	admin := func(method, path string, body any) (int, map[string]any) {
		t.Helper()
		return jsonRequest(t, env.server.URL+path, method, "admin-secret", body)
	}
	const projects = "/admin/api/projects"
	status, project := admin(http.MethodPost, projects, map[string]any{"slug": "retired", "name": "Retired"})
	if status != http.StatusCreated {
		t.Fatalf("create project: status=%d, body=%v", status, project)
	}
	id := project["id"].(string)
	path := projects + "/" + id
	if status, body := admin(http.MethodDelete, path, nil); status != http.StatusConflict {
		t.Fatalf("delete active project: status=%d, body=%v", status, body)
	}
	if status, body := admin(http.MethodPost, projects+"/status", map[string]any{"id": id, "status": "disabled"}); status != http.StatusOK {
		t.Fatalf("disable project: status=%d, body=%v", status, body)
	}
	event := expectOneAdminEvent(t, "project.delete", "admin-secret", func() {
		for attempt := 1; attempt <= 2; attempt++ {
			if status, body := admin(http.MethodDelete, path, nil); status != http.StatusOK || body["ok"] != true {
				t.Fatalf("delete attempt %d: status=%d, body=%v", attempt, status, body)
			}
		}
	})
	if event.TargetType != "project" || event.TargetID != id {
		t.Errorf("delete audit target=%s/%s, want project/%s", event.TargetType, event.TargetID, id)
	}
	if status, body := admin(http.MethodDelete, projects+"/does-not-exist", nil); status != http.StatusNotFound {
		t.Errorf("delete unknown project: status=%d, body=%v", status, body)
	}
}

func TestProjectDeletionRollsBackWhenAuditFails(t *testing.T) {
	env := newCredentialTestEnvWith(t, nil)
	defer env.server.Close()
	project, err := iam.CreateProject("retired", "Retired")
	if err != nil {
		t.Fatal(err)
	}
	if err := iam.SetProjectStatus(project.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	db, err := iam.DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TRIGGER reject_project_delete_audit BEFORE INSERT ON audit_events
WHEN NEW.action='project.delete' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END`); err != nil {
		t.Fatal(err)
	}
	const adminKey = "admin-secret"
	projects := env.server.URL + "/admin/api/projects"
	target := projects + "/" + project.ID
	if status, body := jsonRequest(t, target, http.MethodDelete, adminKey, nil); status != http.StatusInternalServerError {
		t.Fatalf("delete with audit unavailable: status=%d, error=%q, want 500", status, errorText(body))
	}
	status, body := jsonRequest(t, projects, http.MethodGet, adminKey, nil)
	items, _ := body["projects"].([]any)
	if status != http.StatusOK || len(items) != 1 {
		t.Fatalf("projects after audit failure: status=%d, projects=%v", status, items)
	}
	retained := items[0].(map[string]any)
	if retained["id"] != project.ID || retained["status"] != "disabled" {
		t.Fatalf("expected the disabled project after rollback, got %v", retained)
	}
	if _, err := db.Exec("DROP TRIGGER reject_project_delete_audit"); err != nil {
		t.Fatal(err)
	}
	headers := http.Header{"X-Request-Id": {"project-removal-retry"}}
	event := expectOneAdminEvent(t, "project.delete", adminKey, func() {
		if status, body := jsonRequest(t, target, http.MethodDelete, adminKey, nil, headers); status != http.StatusOK || body["ok"] != true {
			t.Fatalf("retry after audit recovery: status=%d, error=%q", status, errorText(body))
		}
	})
	if event.TargetID != project.ID || event.Detail["request_id"] != "project-removal-retry" {
		t.Errorf("retry audit: target=%q, request ID=%v", event.TargetID, event.Detail["request_id"])
	}
}

func TestRemovedProjectCannotBeManaged(t *testing.T) {
	env := newCredentialTestEnvWith(t, nil)
	defer env.server.Close()
	project, err := iam.CreateProject("removed", "Removed")
	if err != nil {
		t.Fatal(err)
	}
	if err := iam.SetMembership(project.ID, env.principalID, "owner"); err != nil {
		t.Fatal(err)
	}
	credential, err := iam.PutGatewayProviderCredential("fixture", "api_key", "synthetic-test-value")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iam.SetProviderCredentialBinding(project.ID, "fixture", "service", credential.ID); err != nil {
		t.Fatal(err)
	}
	if err := iam.SetProjectStatus(project.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	path := "/admin/api/projects/" + project.ID
	if status, body := jsonRequest(t, env.server.URL+path, http.MethodDelete, "admin-secret", nil); status != http.StatusOK {
		t.Fatalf("delete project: status=%d, body=%v", status, body)
	}
	members := "/admin/api/memberships?project_id=" + project.ID
	binding := map[string]any{"provider_id": "fixture", "principal_kind": "service", "credential_id": credential.ID}
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, path + "/policy", nil},
		{http.MethodPost, path + "/policy", map[string]any{"rpm": 13}},
		{http.MethodGet, path + "/limits", nil},
		{http.MethodGet, path + "/provider-credential-bindings", nil},
		{http.MethodPost, path + "/provider-credential-bindings", binding},
		{http.MethodPost, path + "/provider-credential-bindings/status", map[string]any{"provider_id": "fixture", "principal_kind": "service", "status": "disabled"}},
		{http.MethodPost, "/admin/api/projects/status", map[string]any{"id": project.ID, "status": "active"}},
		{http.MethodGet, members, nil},
		{http.MethodPost, "/admin/api/memberships", map[string]any{"project_id": project.ID, "principal_id": env.principalID, "role": "member"}},
		{http.MethodDelete, members + "&principal_id=" + env.principalID, nil},
		{http.MethodPost, "/admin/api/keys", map[string]any{"project_id": project.ID, "principal_id": env.principalID, "name": "new"}},
		{http.MethodPost, "/admin/api/alerts", map[string]any{"project_id": project.ID, "kind": "key_expiry", "threshold": 7}},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			status, body := jsonRequest(t, env.server.URL+tc.path, tc.method, "admin-secret", tc.body)
			if status != http.StatusNotFound {
				t.Errorf("status=%d, error=%q, want 404", status, errorText(body))
			}
		})
	}
}

func TestProjectRemovalRequiresAdminAndUpdatesProjectSelectors(t *testing.T) {
	useAuditTestSettings(t, func(s *config.Settings) {
		s.APIKey = "fixture-admin"
		s.SSOEnabled, s.SSOAutoProvision = true, false
		s.SSOSharedSecret, s.SSOAdminGroup = "fixture-proxy", "fixture-admins"
		s.Providers = nil
	})
	server := httptest.NewServer(NewServer(Runtime{}))
	defer server.Close()
	owner, err := iam.CreatePrincipal("human", "authentik:owner", "", "Owner")
	if err != nil {
		t.Fatal(err)
	}
	memberProject := func(slug string) iam.Project {
		t.Helper()
		project, err := iam.CreateProject(slug, slug)
		if err != nil {
			t.Fatal(err)
		}
		if err := iam.SetMembership(project.ID, owner.ID, "owner"); err != nil {
			t.Fatal(err)
		}
		return project
	}
	removed, kept := memberProject("removed"), memberProject("kept")
	key, err := iam.IssueKey(iam.KeyCreate{ProjectID: kept.ID, PrincipalID: owner.ID, Name: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if err := iam.SetProjectStatus(removed.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	target := server.URL + "/admin/api/projects/" + removed.ID
	if status, _ := jsonRequest(t, target, http.MethodDelete, key.Token, nil); status != http.StatusUnauthorized {
		t.Fatalf("project key delete: status=%d, want 401", status)
	}
	headers := http.Header{}
	headers.Set(ssoSecretHeader, "fixture-proxy")
	headers.Set(ssoSubjectHeader, "owner")
	for _, tc := range []struct {
		group, origin string
		status        int
	}{
		{"members", server.URL, http.StatusForbidden},
		{"fixture-admins", "https://other.example.test", http.StatusForbidden},
		{"fixture-admins", server.URL, http.StatusOK},
	} {
		headers.Set(ssoGroupsHeader, tc.group)
		headers.Set("Origin", tc.origin)
		if status, body := jsonRequest(t, target, http.MethodDelete, "", nil, headers); status != tc.status {
			t.Fatalf("SSO delete for group %q origin %q: status=%d, error=%q, want %d", tc.group, tc.origin, status, errorText(body), tc.status)
		}
	}
	status, audit := jsonRequest(t, server.URL+"/admin/api/audit?action=project.delete&target_id="+removed.ID, http.MethodGet, "", nil, headers)
	events, _ := audit["events"].([]any)
	if status != http.StatusOK || len(events) != 1 {
		t.Fatalf("SSO delete audit: status=%d, events=%v", status, events)
	}
	event := events[0].(map[string]any)
	detail, _ := event["detail"].(map[string]any)
	if event["actor_principal_id"] != owner.ID || detail["actor_source"] != "sso" {
		t.Errorf("SSO delete audit attributed to %v, source=%v", event["actor_principal_id"], detail["actor_source"])
	}
	for _, path := range []string{"/admin/api/projects", "/admin/api/state", "/user/api/me"} {
		status, body := jsonRequest(t, server.URL+path, http.MethodGet, "", nil, headers)
		if status != http.StatusOK {
			t.Fatalf("GET %s: status=%d, error=%q", path, status, errorText(body))
		}
		projects, _ := body["projects"].([]any)
		var keptVisible bool
		for _, raw := range projects {
			project := raw.(map[string]any)
			switch project["id"] {
			case removed.ID:
				t.Errorf("GET %s still lists the deleted project", path)
			case kept.ID:
				keptVisible = true
			}
		}
		if !keptVisible {
			t.Errorf("GET %s lost the surviving project", path)
		}
	}
}
