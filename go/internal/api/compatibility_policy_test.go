package api

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"testing"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
)

func TestCompatibilityHeaderValidation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		headers http.Header
		bad     bool
	}{
		{"native default", http.Header{}, false},
		{"allow", http.Header{"X-Llmgw-Compatibility": {"allow"}}, false},
		{"deny", http.Header{"X-Llmgw-Compatibility": {"deny"}}, false},
		{"unknown", http.Header{"X-Llmgw-Compatibility": {"force"}}, true},
		{"empty", http.Header{"X-Llmgw-Compatibility": {""}}, true},
		{"combined", http.Header{"X-Llmgw-Compatibility": {"allow, deny"}}, true},
		{"duplicated", http.Header{"X-Llmgw-Compatibility": {"allow", "deny"}}, true},
		{"mixed case duplicates", http.Header{"X-Llmgw-Compatibility": {"allow"}, "x-llmgw-compatibility": {"deny"}}, true},
		{"transparent and allow", http.Header{"X-Llmgw-Transport-Mode": {"transparent"}, "X-Llmgw-Compatibility": {"allow"}}, true},
		{"transparent and deny", http.Header{"X-Llmgw-Transport-Mode": {"transparent"}, "X-Llmgw-Compatibility": {"deny"}}, false},
		{"duplicate transport", http.Header{"X-Llmgw-Transport-Mode": {"transparent", "transparent"}}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			request.Header = tc.headers
			_, err := requestedTransportMode(request)
			if (err != nil) != tc.bad {
				t.Fatalf("header error=%v, want error=%v", err, tc.bad)
			}
		})
	}
}

func routeContractServer(t *testing.T) *httptest.Server {
	t.Helper()
	state := t.TempDir()
	t.Setenv("LLMGW_STATE_DIR", state)
	t.Setenv("LLMGW_CONFIG", filepath.Join(state, "config.yaml"))
	old := *config.Get()
	iam.ResetForTests()
	providers.ResetProviders()
	t.Cleanup(func() {
		providers.ResetProviders()
		iam.ResetForTests()
		config.Update(func(s *config.Settings) { *s = old })
	})
	config.Update(func(s *config.Settings) {
		s.APIKey, s.APIKeys, s.AllowUnauthenticatedAPI, s.SSOEnabled = "admin-secret", nil, false, false
		s.CredentialEncryptionKey = ""
		s.Providers = map[string]*config.ProviderConfig{"echo": {Type: "echo"}}
		s.Endpoints = map[string]*config.EndpointConfig{}
	})
	if _, err := iam.Initialize(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(Runtime{}))
	t.Cleanup(server.Close)
	return server
}

func TestAdminRouteContractRoundTrip(t *testing.T) {
	for _, path := range []string{"/admin/api/endpoints", "/admin/api/categories"} {
		t.Run(path, func(t *testing.T) {
			server := routeContractServer(t)
			ingress := []string{"/v1/chat/completions"}
			body := map[string]any{"name": "coding", "ingress": ingress, "allow_adaptation": true, "failover": []map[string]any{{"provider": "echo", "model": "echo-default"}}}
			status, answer := jsonRequest(t, server.URL+path, http.MethodPost, "admin-secret", body)
			if status != http.StatusOK {
				t.Fatalf("save status=%d body=%v", status, answer)
			}
			if route := config.Get().Endpoints["coding"]; !route.AllowAdaptation || !reflect.DeepEqual(route.Ingress, ingress) {
				t.Fatalf("saved route lost its contract: %+v", route)
			}
			status, state := jsonRequest(t, server.URL+"/admin/api/state", http.MethodGet, "admin-secret", nil)
			if status != http.StatusOK {
				t.Fatalf("state status=%d", status)
			}
			route := state["endpoints"].(map[string]any)["coding"].(map[string]any)
			if route["allow_adaptation"] != true || !reflect.DeepEqual(route["ingress"], []any{"/v1/chat/completions"}) {
				t.Fatalf("state lost route contract: %v", route)
			}
			if _, err := config.Load(); err != nil {
				t.Fatal(err)
			}
			if route := config.Get().Endpoints["coding"]; !route.AllowAdaptation || !reflect.DeepEqual(route.Ingress, ingress) {
				t.Fatalf("disk reload lost route contract: %+v", route)
			}
		})
	}
}

func TestAdminRouteContractRejectsImplicitOrInvalidAdaptation(t *testing.T) {
	for _, declaration := range []map[string]any{
		{"allow_adaptation": true},
		{"allow_adaptation": true, "ingress": []string{"/not-an-api"}},
		{"allow_adaptation": "true", "ingress": []string{"/v1/chat/completions"}},
	} {
		t.Run("invalid contract", func(t *testing.T) {
			server := routeContractServer(t)
			declaration["name"] = "coding"
			declaration["failover"] = []map[string]any{{"provider": "echo", "model": "echo-default"}}
			status, _ := jsonRequest(t, server.URL+"/admin/api/endpoints", http.MethodPost, "admin-secret", declaration)
			if status != http.StatusBadRequest || config.Get().Endpoints["coding"] != nil {
				t.Fatalf("invalid route contract published: status=%d", status)
			}
		})
	}
}
