package api

import (
	"net/http"
	"strings"
	"testing"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
)

func TestDaemonSetupTokenConnectionAndPublicAnthropicKeyRemainDistinct(t *testing.T) {
	e := newCredentialTestEnvWith(t, map[string]*config.ProviderConfig{
		"public": {Type: "anthropic", RegistryID: "anthropic"},
		"setup":  {Type: providers.ExtensionTypeAnthropicSetup},
		"chat":   {Type: "openai_compatible"},
	})
	defer e.server.Close()
	token := AnthropicSetupTokenPrefix + strings.Repeat("a", 80)
	path := e.server.URL + "/admin/api/principals/" + e.principalID + "/connections"
	for _, tc := range []struct {
		provider, kind, secret string
		want                   int
	}{
		{"setup", "setup_token", token, http.StatusCreated},
		{"setup", "setup_token", AnthropicSetupTokenPrefix + "short", http.StatusBadRequest},
		{"setup", "api_key", "fixture-public-key", http.StatusBadRequest},
		{"public", "api_key", "fixture-public-key", http.StatusCreated},
		{"chat", "setup_token", token, http.StatusBadRequest},
	} {
		t.Run(tc.provider+"/"+tc.kind+"/"+http.StatusText(tc.want), func(t *testing.T) {
			status, body := jsonRequest(t, path, http.MethodPost, "admin-secret", map[string]any{
				"provider_id": tc.provider, "connection_name": tc.kind, "credential_kind": tc.kind, "secret": tc.secret,
			})
			if status != tc.want {
				t.Fatalf("status=%d want=%d", status, tc.want)
			}
			if strings.Contains(jsonStr(body), tc.secret) {
				t.Fatal("credential echoed in response")
			}
			if tc.want == http.StatusCreated {
				stored, _, found, err := iam.ProviderConnectionSecret(e.principalID, tc.provider, tc.kind)
				if err != nil || !found || stored != tc.secret {
					t.Fatalf("credential not usable: found=%v err=%v", found, err)
				}
			}
		})
	}
}
