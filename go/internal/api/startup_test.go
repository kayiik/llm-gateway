package api

import (
	"strings"
	"testing"

	"llmgw/internal/config"
)

// useStartupSettings gives a test settings without warnings of their own,
// and restores the previous ones when it ends.
func useStartupSettings(t *testing.T, providers map[string]*config.ProviderConfig) {
	t.Helper()
	old := *config.Get()
	t.Cleanup(func() { config.Update(func(s *config.Settings) { *s = old }) })
	config.Update(func(s *config.Settings) {
		s.AllowUnauthenticatedAPI, s.APIKeys = false, nil
		s.Providers, s.Extensions = providers, nil
	})
	t.Setenv("LLMGW_EXTENSION_URL", "")
	t.Setenv("LLMGW_EXTENSION_SECRET", "")
}

// The variables that configured the companion daemon before extensions are
// no longer read. While one is still set the gateway says so, and how to
// move the daemon to an extension, naming the variables but never their
// values.
func TestStartupWarnsThatTheExtensionVariablesAreNoLongerRead(t *testing.T) {
	useStartupSettings(t, map[string]*config.ProviderConfig{})
	t.Setenv("LLMGW_EXTENSION_URL", "http://127.0.0.1:18888")
	t.Setenv("LLMGW_EXTENSION_SECRET", "fixture-retired-secret")
	warnings := StartupWarnings("127.0.0.1")
	if len(warnings) != 1 || !containsAll(warnings[0], "LLMGW_EXTENSION_URL and LLMGW_EXTENSION_SECRET are set",
		"no longer reads them", "Providers -> Extensions", "POST /admin/api/extensions", "remove the variables") ||
		strings.Contains(warnings[0], "fixture-retired-secret") || strings.Contains(warnings[0], "18888") {
		t.Fatalf("warnings=%q, want one naming both variables and not their values", warnings)
	}
	t.Setenv("LLMGW_EXTENSION_URL", " ")
	warnings = StartupWarnings("127.0.0.1")
	if len(warnings) != 1 || !strings.Contains(warnings[0], "LLMGW_EXTENSION_SECRET is set") ||
		strings.Contains(warnings[0], "LLMGW_EXTENSION_URL") || strings.Contains(warnings[0], "fixture-retired-secret") {
		t.Fatalf("warnings=%q, want one naming the secret's variable alone", warnings)
	}
	t.Setenv("LLMGW_EXTENSION_SECRET", "")
	if warnings := StartupWarnings("127.0.0.1"); len(warnings) != 0 {
		t.Fatalf("without the variables: warnings=%q, want none", warnings)
	}
}

// A provider of a type the companion daemon serves that no extension serves
// cannot serve a request, so the gateway names it; a disabled provider is
// left out. An extension whose secret does not decrypt is named with why.
func TestStartupWarnsOfProvidersNoExtensionServes(t *testing.T) {
	useStartupSettings(t, map[string]*config.ProviderConfig{
		"openai":  {Type: "openai_compatible"},
		"copilot": {Type: "github_copilot"},
		"codex":   {Type: "openai_compatible", RegistryID: "openai_codex"},
		"zen":     {Type: "opencode_zen_anonymous", Disabled: true},
	})
	unserved := func(want string) {
		t.Helper()
		warnings := StartupWarnings("127.0.0.1")
		if want == "" {
			if len(warnings) != 0 {
				t.Fatalf("warnings=%q, want none", warnings)
			}
			return
		}
		if len(warnings) != 1 || !containsAll(warnings[0], want, "Providers -> Extensions", "POST /admin/api/extensions") ||
			strings.Contains(warnings[0], "zen") || strings.Contains(warnings[0], "openai,") {
			t.Fatalf("warnings=%q, want one naming %s", warnings, want)
		}
	}
	unserved("no extension serves provider(s) codex, copilot,")
	home := config.Extension{ID: "home", URL: "http://127.0.0.1:18888", Secret: "fixture-secret"}
	office := config.Extension{ID: "office", URL: "http://127.0.0.1:18889", Secret: "fixture-secret"}
	useExtensions(t, home)
	unserved("")
	// A second extension leaves the providers that name none to choose.
	useExtensions(t, home, office)
	unserved("no extension serves provider(s) codex, copilot,")
	config.Update(func(s *config.Settings) {
		s.Providers["codex"] = &config.ProviderConfig{Type: "openai_compatible", RegistryID: "openai_codex", Extension: "office"}
		s.Providers["copilot"] = &config.ProviderConfig{Type: "github_copilot", Extension: "garage"}
	})
	unserved("no extension serves provider(s) copilot,")
	config.Update(func(s *config.Settings) {
		s.Providers["copilot"] = &config.ProviderConfig{Type: "github_copilot", Extension: "home"}
	})
	unserved("")
	home.Secret, home.Unusable = "", "its secret does not decrypt with the configured credential encryption key"
	useExtensions(t, home, office)
	if warnings := StartupWarnings("127.0.0.1"); len(warnings) != 1 ||
		!containsAll(warnings[0], `extension "home" cannot be used`, "does not decrypt") {
		t.Fatalf("warnings=%q, want one naming the unusable extension", warnings)
	}
}
