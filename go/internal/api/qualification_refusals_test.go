package api

import (
	"net/http"
	"testing"

	"llmgw/internal/config"
	"llmgw/internal/iam"
)

func TestPlaygroundRefusalsDoNotDispatchOrConsume(t *testing.T) {
	f := newNativePolicyFixture(t)
	config.Update(func(s *config.Settings) {
		s.SSOEnabled, s.SSOSharedSecret, s.SSOAutoProvision = true, "proxy-secret", true
	})
	project, err := iam.CreateProject("refusal-project", "Refusal Project")
	if err != nil {
		t.Fatal(err)
	}
	disabled, err := iam.CreateProject("disabled-project", "Disabled Project")
	if err != nil {
		t.Fatal(err)
	}
	if err := iam.SetProjectStatus(disabled.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"viewer", "member", "owner", "admin"} {
		person, err := iam.EnsurePrincipalBySubject("human", "authentik:refusal-"+role, "", role)
		if err != nil {
			t.Fatal(err)
		}
		if err := iam.SetMembership(project.ID, person.ID, role); err != nil {
			t.Fatal(err)
		}
	}
	db, err := iam.DB()
	if err != nil {
		t.Fatal(err)
	}
	snapshot := func() (int, int) {
		t.Helper()
		var events, requests int
		if err := db.QueryRow("SELECT COUNT(*) FROM usage_events").Scan(&events); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow("SELECT COALESCE(SUM(requests),0) FROM project_quota_counters").Scan(&requests); err != nil {
			t.Fatal(err)
		}
		return events, requests
	}
	serviceToken, _ := issueProviderTestKey(t, "refusal-service", "service:refusal", "service", "", false)
	for _, surface := range []struct{ path, model string }{
		{"chat/completions", "chat/fixture"}, {"responses", "responses/fixture"}, {"messages", "messages/fixture"},
	} {
		for _, tc := range []struct {
			name, subject, project string
			status                 int
		}{
			{"missing-project", "refusal-owner", "", 400},
			{"unknown-project", "refusal-owner", "missing", 404},
			{"disabled-project", "refusal-owner", disabled.ID, 404},
			{"outsider", "refusal-outsider", project.ID, 403},
			{"viewer", "refusal-viewer", project.ID, 403},
			{"member", "refusal-member", project.ID, 403},
			{"owner", "refusal-owner", project.ID, 200},
			{"admin", "refusal-admin", project.ID, 200},
		} {
			t.Run(surface.path+"/"+tc.name, func(t *testing.T) {
				body := map[string]any{"project_id": tc.project, "model": surface.model, "messages": []any{map[string]any{"role": "user", "content": "hello"}}, "max_tokens": 8}
				if surface.path == "responses" {
					delete(body, "messages")
					delete(body, "max_tokens")
					body["input"], body["max_output_tokens"] = "hello", 8
				}
				beforeCalls := f.chat.Load() + f.messages.Load() + f.responses.Load()
				beforeEvents, beforeRequests := snapshot()
				status, response := ssoConnectionRequest(t, f.server.URL, tc.subject, http.MethodPost, "/user/api/playground/v1/"+surface.path, body)
				if status != tc.status {
					t.Fatalf("status=%d want=%d response=%+v", status, tc.status, response)
				}
				afterEvents, afterRequests := snapshot()
				if tc.status != 200 && (f.chat.Load()+f.messages.Load()+f.responses.Load() != beforeCalls || afterEvents != beforeEvents || afterRequests != beforeRequests) {
					t.Fatalf("refusal dispatched/consumed: calls=%d events=%d requests=%d", f.chat.Load()+f.messages.Load()+f.responses.Load()-beforeCalls, afterEvents-beforeEvents, afterRequests-beforeRequests)
				}
				if tc.status == 200 && afterEvents <= beforeEvents {
					t.Fatal("accepted request did not record usage")
				}
			})
		}
		for _, token := range []string{"", serviceToken} {
			beforeEvents, beforeRequests := snapshot()
			beforeCalls := f.chat.Load() + f.messages.Load() + f.responses.Load()
			status, response := jsonRequest(t, f.server.URL+"/user/api/playground/v1/"+surface.path, http.MethodPost, token,
				map[string]any{"project_id": project.ID, "model": surface.model, "messages": []any{map[string]any{"role": "user", "content": "hello"}}, "input": "hello", "max_tokens": 8})
			if status != http.StatusUnauthorized {
				t.Fatalf("non-person playground: status=%d response=%+v", status, response)
			}
			afterEvents, afterRequests := snapshot()
			if f.chat.Load()+f.messages.Load()+f.responses.Load() != beforeCalls || afterEvents != beforeEvents || afterRequests != beforeRequests {
				t.Fatal("non-person refusal dispatched/consumed")
			}
		}
	}
}
