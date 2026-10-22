package providers

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"llmgw/internal/config"

	core "github.com/kayiik/llmgw-core"
)

// SupportsGeminiLiveTransport excludes extension and Vertex bindings even when
// their model names look like a Gemini API model.
func SupportsGeminiLiveTransport(settings *config.Settings, providerID string) bool {
	cfg := settings.Providers[providerID]
	return cfg != nil && !cfg.Disabled && cfg.Extension == "" && strings.EqualFold(cfg.Type, "ai_studio")
}

// GeminiLiveTarget freezes the same caller-bound credential as Google's other
// transports. Credentials are headers, never query parameters or client events.
func (rt *Runtime) GeminiLiveTarget(settings *config.Settings, providerID string, caller core.Caller) (string, http.Header, error) {
	if !SupportsGeminiLiveTransport(settings, providerID) {
		return "", nil, errors.New("provider does not serve Gemini Live")
	}
	instance, err := rt.instantiate(settings, providerID, settings.Providers[providerID], caller)
	if err != nil {
		return "", nil, errors.New("Gemini Live credential could not be prepared")
	}
	p, ok := instance.(*googleProvider)
	if !ok || p.legacy.surface != SurfaceAIStudio || p.legacy.apiKey == "" {
		return "", nil, errors.New("Gemini Live requires a caller-authorized AI Studio API key")
	}
	u, err := url.Parse(p.legacy.baseURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", nil, errors.New("Gemini Live provider URL is invalid")
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
	u.RawPath = ""
	return u.String(), http.Header{"X-Goog-Api-Key": {p.legacy.apiKey}}, nil
}
