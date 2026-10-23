package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"

	"github.com/kayiik/llmgw-core/extension"
)

func TestProviderQuotaRefreshHTTPFencedAllowance(t *testing.T) {
	gateway := useExtensionsAPI(t, true)
	var calls atomic.Int32
	var mode atomic.Value
	mode.Store("observed")
	observed := time.Now().UTC().Add(-30 * time.Second).Truncate(time.Second)
	reset := time.Now().UTC().Add(5 * time.Minute).Truncate(time.Second)
	zero, half := 0.0, 0.5
	var rotate func()
	var cancelRefresh context.CancelFunc
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodGet || r.URL.Path != extension.PathPrefix+providers.ExtensionTypeAntigravity+"/allowance" ||
			r.Header.Get("Authorization") != "Bearer "+extensionTestSecret || r.Header.Get(extension.HeaderCredentialToken) != "selected-access" {
			t.Error("allowance did not use the configured extension and exact selected credential")
		}
		switch mode.Load().(string) {
		case "unknown":
			writeJSON(w, 200, extension.AllowanceResponse{Status: "unknown"})
			return
		case "auth", "unsupported":
			status := 401
			if mode.Load().(string) == "unsupported" {
				status = 404
			}
			writeJSON(w, status, map[string]any{"error": "selected-access " + extensionTestSecret})
			return
		case "malformed":
			_, _ = w.Write([]byte(`{"status":"observed","observations":[{"model_id":"m","remaining_fraction":2}]}`))
			return
		case "duplicate":
			writeJSON(w, 200, extension.AllowanceResponse{Status: "observed", Observations: []extension.AllowanceObservation{
				{ModelID: "m", ObservedAt: observed, RemainingFraction: &zero},
				{ModelID: "m", ObservedAt: observed, RemainingFraction: &half},
			}})
			return
		case "rotate":
			rotate()
		case "cancel":
			cancelRefresh()
		}
		writeJSON(w, 200, extension.AllowanceResponse{Status: "observed", Observations: []extension.AllowanceObservation{
			{ProjectID: "project-a", ModelID: "m", ObservedAt: observed, RemainingFraction: &zero, ResetAt: &reset},
			{ProjectID: "project-b", ModelID: "m", ObservedAt: observed, RemainingFraction: &half},
		}})
	}))
	defer upstream.Close()
	config.Update(func(s *config.Settings) {
		s.SSOEnabled, s.SSOSharedSecret, s.SSOAutoProvision = true, "proxy-secret", true
		s.Providers = map[string]*config.ProviderConfig{
			"personal": {Type: providers.ExtensionTypeAntigravity, Extension: "local"},
			"plain":    {Type: "echo"},
		}
		s.Extensions = map[string]config.Extension{"local": {URL: upstream.URL, Secret: extensionTestSecret}}
	})
	providers.InstallForTests(t)
	owner, err := iam.CreatePrincipal("human", "authentik:allowance-owner", "", "Allowance Owner")
	if err != nil {
		t.Fatal(err)
	}
	input := iam.OAuthConnectionCreate{PrincipalID: owner.ID, ProviderID: "personal", Name: "selected", AccessToken: "selected-access", Source: iam.ConnectionSourceUser}
	selected, err := iam.PutOAuthProviderConnection(input)
	if err != nil {
		t.Fatal(err)
	}
	decoy := input
	decoy.Name, decoy.AccessToken, decoy.MakeDefault = "default-decoy", "decoy-access", true
	if _, err := iam.PutOAuthProviderConnection(decoy); err != nil {
		t.Fatal(err)
	}
	path := "/user/api/connections/" + selected.ID + "/quota/refresh"
	if status, body := ssoConnectionRequest(t, gateway.URL, "other-owner", http.MethodPost, path, nil); status != 404 {
		t.Fatalf("cross-owner status=%d body=%v", status, body)
	}
	if calls.Load() != 0 {
		t.Fatal("cross-owner refresh dispatched")
	}
	adminPath := "/admin/api/connections/" + selected.ID + "/quota/refresh"
	if status, _ := jsonRequest(t, gateway.URL+adminPath, http.MethodPost, "wrong-admin", nil); status != 401 {
		t.Fatalf("unauthorized admin status=%d", status)
	}
	assertSafe := func(body map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(body)
		for _, secret := range []string{"selected-access", "decoy-access", extensionTestSecret} {
			if strings.Contains(string(raw), secret) {
				t.Fatal("refresh response exposed a fixture credential")
			}
		}
	}
	status, body := ssoConnectionRequest(t, gateway.URL, "allowance-owner", http.MethodPost, path, map[string]any{"token": "ignored", "provider": "plain", "revision": 999})
	if status != 200 || body["status"] != "observed" || calls.Load() != 1 {
		t.Fatalf("refresh status=%d body=%v calls=%d", status, body, calls.Load())
	}
	assertSafe(body)
	stored, err := iam.ListProviderQuotaSnapshots(iam.ProviderQuotaFilter{ConnectionID: selected.ID})
	if err != nil || len(stored) != 2 || stored[0].Metric == stored[1].Metric {
		t.Fatalf("qualified storage=%v err=%v", stored, err)
	}
	for _, snapshot := range stored {
		if snapshot.Unit != "fraction" || snapshot.Confidence != "unknown" || snapshot.RefreshedAt != observed.Unix() || snapshot.ExpiresAt > observed.Add(iam.ProviderQuotaDefaultFreshness).Unix() || snapshot.LimitValue != nil || snapshot.UsedValue != nil {
			t.Fatalf("invented quantities/freshness: %+v", snapshot)
		}
		if *snapshot.RemainingValue == 0 && snapshot.ExpiresAt != reset.Unix() {
			t.Fatalf("reset did not bound freshness: %+v", snapshot)
		}
	}
	status, usage := ssoConnectionRequest(t, gateway.URL, "allowance-owner", http.MethodGet, "/user/api/usage", nil)
	if status != 200 {
		t.Fatalf("usage=%d %v", status, usage)
	}
	foundZero := false
	for _, item := range usage["quota_advisories"].([]any) {
		advisory := item.(map[string]any)
		if advisory["provider_id"] != "personal" {
			continue
		}
		if advisory["status"] != "unknown" || advisory["confidence"] != "unknown" || advisory["source"] != "antigravity_best_effort" {
			t.Fatalf("unverified evidence misrepresented: %v", advisory)
		}
		for _, raw := range advisory["dimensions"].([]any) {
			dimension := raw.(map[string]any)
			if dimension["unverified"] != true || dimension["limit"] != nil || dimension["used"] != nil {
				t.Fatalf("dimension=%v", dimension)
			}
			foundZero = foundZero || dimension["remaining"] == float64(0)
		}
	}
	if !foundZero {
		t.Fatal("explicit observed zero lost in usage projection")
	}
	for _, failure := range []string{"unknown", "auth", "unsupported", "malformed", "duplicate"} {
		t.Run(failure, func(t *testing.T) {
			mode.Store(failure)
			status, answer := jsonRequest(t, gateway.URL+adminPath, http.MethodPost, "admin-secret", nil)
			want := "unknown"
			if failure == "unsupported" {
				want = "unsupported"
			}
			if status != 200 || answer["status"] != want {
				t.Fatalf("optional failure=%d %v", status, answer)
			}
			assertSafe(answer)
			after, err := iam.ListProviderQuotaSnapshots(iam.ProviderQuotaFilter{ConnectionID: selected.ID})
			if err != nil || string(mustJSON(t, after)) != string(mustJSON(t, stored)) {
				t.Fatal("unknown refresh replaced or freshly dated cached evidence")
			}
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	cancelRefresh = cancel
	mode.Store("cancel")
	request := httptest.NewRequest(http.MethodPost, adminPath, nil).WithContext(ctx)
	request.SetPathValue("id", selected.ID)
	request.Header.Set("Authorization", "Bearer admin-secret")
	recorder := httptest.NewRecorder()
	handleAdminRefreshProviderQuota(recorder, request)
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"status":"unknown"`) {
		t.Fatalf("cancelled refresh: %d %s", recorder.Code, recorder.Body.String())
	}
	unchanged, err := iam.ListProviderQuotaSnapshots(iam.ProviderQuotaFilter{ConnectionID: selected.ID})
	if err != nil || string(mustJSON(t, unchanged)) != string(mustJSON(t, stored)) {
		t.Fatal("cancelled refresh changed cached evidence")
	}
	plain, err := iam.PutProviderConnection(iam.ProviderConnectionCreate{PrincipalID: owner.ID, ProviderID: "plain", Kind: "api_key", Secret: "fixture", Source: iam.ConnectionSourceUser})
	if err != nil {
		t.Fatal(err)
	}
	before := calls.Load()
	if status, body := jsonRequest(t, gateway.URL+"/admin/api/connections/"+plain.ID+"/quota/refresh", http.MethodPost, "admin-secret", nil); status != 200 || body["status"] != "unsupported" || calls.Load() != before {
		t.Fatalf("non-adapter refresh %d %v", status, body)
	}
	rotate = func() {
		input.AccessToken = "rotated-access"
		if _, err := iam.PutOAuthProviderConnection(input); err != nil {
			t.Error(err)
		}
	}
	mode.Store("rotate")
	if status, body := jsonRequest(t, gateway.URL+adminPath, http.MethodPost, "admin-secret", nil); status != 200 || body["status"] != "unknown" {
		t.Fatalf("rotation status=%d body=%v", status, body)
	}
	after, err := iam.ListProviderQuotaSnapshots(iam.ProviderQuotaFilter{ConnectionID: selected.ID})
	if err != nil || len(after) != 0 {
		t.Fatalf("stale in-flight result survived rotation: %v %v", after, err)
	}
	if err := iam.RevokeProviderConnection(owner.ID, selected.ID); err != nil {
		t.Fatal(err)
	}
	before = calls.Load()
	if status, _ := ssoConnectionRequest(t, gateway.URL, "allowance-owner", http.MethodPost, path, nil); status != 404 || calls.Load() != before {
		t.Fatal("revoked connection refresh dispatched")
	}
}
