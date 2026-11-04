package providers

import (
	"strings"

	"llmgw/internal/config"

	core "github.com/kayiik/llmgw-core"
)

// OfflineAPIKey exposes only transports whose upstream credential is an API key
// and whose wire format a standalone client can call without gateway state.
// It uses the same caller-scoped connection precedence as live inference.
func OfflineAPIKey(settings *config.Settings, providerID string, caller core.Caller) (dialect, baseURL, secret string, ok bool, err error) {
	cfg := settings.Providers[providerID]
	if cfg == nil || cfg.Disabled || cfg.Extension != "" || strings.TrimSpace(cfg.BaseURL) == "" {
		return "", "", "", false, nil
	}
	switch strings.ToLower(strings.TrimSpace(cfg.Type)) {
	case "openai_compatible", "openai", "litellm":
		dialect = "chat"
	case "anthropic":
		dialect = "messages"
	default:
		return "", "", "", false, nil
	}
	var kind string
	secret, kind, _, err = resolveCredentialObserved(settings, providerID, cfg, caller)
	if err != nil {
		return "", "", "", false, err
	}
	if !strings.EqualFold(strings.TrimSpace(kind), CredentialKindAPIKey) || strings.TrimSpace(secret) == "" {
		return "", "", "", false, nil
	}
	return dialect, cfg.BaseURL, secret, true, nil
}
