package api

import (
	"net/http"
	"strings"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/providers"
)

type clientTarget struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Dialect  string `json:"dialect"`
	BaseURL  string `json:"base_url"`
	APIKey   string `json:"api_key"`
}

type clientSelector struct {
	Targets         []string `json:"targets"`
	Ingress         []string `json:"ingress,omitempty"`
	AllowAdaptation bool     `json:"allow_adaptation"`
}

// handleClientSnapshot returns only configured direct transports authorized by
// this key. No administrator, local-mode or external key can export credentials.
func handleClientSnapshot(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, ok := authed(w, r)
	if !ok {
		return
	}
	if p.KeyID == "" || !p.OfflineAccess {
		writeError(w, http.StatusForbidden, "This key does not allow offline access.")
		return
	}
	list, err := buildModelList(p)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Model catalog unavailable.")
		return
	}
	settings := config.Get()
	selectors := map[string]clientSelector{}
	targets := map[string]clientTarget{}
	for _, item := range list["data"].([]any) {
		row := item.(map[string]any)
		selector := row["id"].(string)
		// Discovery aliases are not independent policy grants.
		if row["owned_by"] != "endpoint" && !strings.Contains(selector, "/") {
			continue
		}
		resolved, err := resolveModel(r.Context(), selector, p)
		if err != nil {
			continue
		}
		eligible, status, _ := authorizeKeyPolicy(p, selector, resolved.Category, resolved.Targets)
		if status != 0 {
			continue
		}
		entry := clientSelector{Targets: []string{}}
		if endpoint := settings.Endpoints[resolved.Category]; endpoint != nil {
			entry.AllowAdaptation = endpoint.AllowAdaptation
			entry.Ingress = endpoint.Ingress
		}
		for _, target := range eligible {
			dialect, baseURL, secret, usable, err := providers.OfflineAPIKey(settings, target.Provider, callerOf(p))
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Provider credential unavailable.")
				return
			}
			if !usable {
				continue
			}
			var model providers.ModelInfo
			found := false
			for _, candidate := range catalogModelsForPrincipal(target.Provider, p) {
				if candidate.ID == target.Model {
					model, found = candidate, true
					break
				}
			}
			if !found {
				continue
			}
			native := map[string]bool{}
			for _, surface := range model.SupportedSurfaces {
				native[strings.TrimPrefix(surface, "/v1")] = true
			}
			if dialect == "chat" && !native["/chat/completions"] {
				if native["/responses"] {
					dialect = "responses"
				} else {
					continue
				}
			} else if dialect == "messages" && !native["/messages"] {
				continue
			}
			id := target.Provider + "/" + target.Model
			entry.Targets = append(entry.Targets, id)
			targets[id] = clientTarget{Provider: target.Provider, Model: target.Model, Dialect: dialect, BaseURL: baseURL, APIKey: secret}
		}
		if len(entry.Targets) > 0 {
			selectors[selector] = entry
		}
	}
	// Clients rely on each selector's ordered target list, not JSON map order.
	writeJSON(w, http.StatusOK, map[string]any{
		"version": 1, "fetched_at": time.Now().UTC().Format(time.RFC3339),
		"selectors": selectors, "targets": targets,
	})
}
