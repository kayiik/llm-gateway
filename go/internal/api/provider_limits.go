package api

import (
	"net/http"

	"llmgw/internal/config"
	"llmgw/internal/providers"
)

// A limits-only edit must not replay an old provider form over its credentials,
// extension binding or endpoint configuration.
func handleProviderUsageLimits(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	id := r.PathValue("id")
	if config.Get().Providers[id] == nil {
		writeError(w, http.StatusNotFound, "unknown provider")
		return
	}
	var body struct {
		UsageLimits *config.ProviderUsageLimits `json:"usage_limits"`
	}
	if !decodeBody(r, &body) || body.UsageLimits == nil {
		writeError(w, http.StatusBadRequest, "body must contain usage_limits; use an empty object to clear limits")
		return
	}
	if err := body.UsageLimits.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	_, err := config.UpdateAndSave(func(settings *config.Settings) error {
		provider := settings.Providers[id]
		if provider == nil {
			return config.ErrRestoreSuperseded
		}
		provider.UsageLimits = body.UsageLimits
		return nil
	})
	if err != nil {
		writeConfigSaveError(w, "Provider limits could not be persisted.", err)
		return
	}
	providers.ResetProviders()
	auditAdmin(r, "provider.usage_limits", "provider", id, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "provider_id": id, "usage_limits": body.UsageLimits})
}
