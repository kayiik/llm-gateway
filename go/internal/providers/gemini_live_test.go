package providers

import (
	"strings"
	"testing"

	"llmgw/internal/config"

	core "github.com/kayiik/llmgw-core"
)

func TestGeminiLiveCallerBoundTarget(t *testing.T) {
	rt := NewRuntime()
	settings := &config.Settings{Providers: map[string]*config.ProviderConfig{
		"studio": {Type: "ai_studio", BaseURL: "https://example.invalid/v1beta", APIKey: "fixture-live-secret"},
	}}
	target, headers, err := rt.GeminiLiveTarget(settings, "studio", core.Caller{})
	if err != nil || target != "wss://example.invalid/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" || headers.Get("x-goog-api-key") != "fixture-live-secret" {
		t.Fatalf("incorrect prepared Live binding: target=%s err=%v", target, err)
	}
	if strings.Contains(target, "fixture-live-secret") || headers.Get("Authorization") != "" {
		t.Fatal("credential escaped its dedicated provider header")
	}
	for _, cfg := range []*config.ProviderConfig{
		{Type: "ai_studio", Extension: "private"}, {Type: "vertex_ai"}, {Type: "openai_compatible"}, {Type: "ai_studio", Disabled: true},
	} {
		settings.Providers["studio"] = cfg
		if SupportsGeminiLiveTransport(settings, "studio") {
			t.Fatalf("non-native binding accepted: type=%s", cfg.Type)
		}
	}
}

func TestGeminiLiveTargetRejectsCredentialURLs(t *testing.T) {
	for _, base := range []string{"https://user:secret@example.invalid/v1beta", "https://example.invalid/v1beta?key=fixture-secret", "https://example.invalid/v1beta#secret"} {
		settings := &config.Settings{Providers: map[string]*config.ProviderConfig{
			"studio": {Type: "ai_studio", BaseURL: base, APIKey: "fixture-live-secret"},
		}}
		_, headers, err := NewRuntime().GeminiLiveTarget(settings, "studio", core.Caller{})
		if err == nil || headers != nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid provider URL was accepted or echoed")
		}
	}
}
