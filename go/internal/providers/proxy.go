package providers

import (
	"net/http"

	"llmgw/internal/config"

	core "github.com/kayiik/llmgw-core"
)

// SupportsRealtimeHTTPTransport identifies the registered native compatible
// transport, not a model capability. A legacy compatible-shaped configuration
// can instead bind a subscription/extension driver, which cannot proxy this API.
func (rt *Runtime) SupportsRealtimeHTTPTransport(providerID string) bool {
	settings, _ := (config.Source{}).Snapshot()
	cfg := settings.Providers[providerID]
	if cfg == nil || cfg.Disabled {
		return false
	}
	vertical, _, found := rt.vertical(settings, providerID)
	return found && vertical == openAICompatibleCoreType
}

// ProviderHTTPTarget returns the resolved base URL + auth headers for an
// OpenAI-standard provider, so non-chat endpoints (audio transcription/speech)
// can be reverse-proxied to the provider using the same auth + base URL the chat
// transport uses. ok is false for non-OpenAI providers (anthropic, ollama) or
// when auth can't be prepared.
func (rt *Runtime) ProviderHTTPTarget(
	providerID string, caller core.Caller,
) (baseURL string, headers http.Header, ok bool) {
	settings := config.Get()
	cfg, exists := settings.Providers[providerID]
	if !exists {
		return "", nil, false
	}
	inst, err := rt.instantiate(settings, providerID, cfg, caller)
	if err != nil {
		return "", nil, false
	}
	openAI, isOpenAI := inst.(*openAICompatibleProvider)
	if !isOpenAI {
		return "", nil, false
	}
	base, hdr := openAI.httpTarget()
	return base, hdr, true
}
