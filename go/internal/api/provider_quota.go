package api

import (
	"errors"
	"net/http"
	"strings"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
)

func handleAdminRefreshProviderQuota(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	refreshProviderQuota(w, r, "")
}

func handleUserRefreshProviderQuota(w http.ResponseWriter, r *http.Request) {
	principal, ok := requireSSOUser(w, r)
	if !ok {
		return
	}
	refreshProviderQuota(w, r, principal.ID)
}

func refreshProviderQuota(w http.ResponseWriter, r *http.Request, principalID string) {
	connections, err := iam.ListProviderConnections(principalID, "")
	if err != nil {
		writeError(w, 500, "Credential store unavailable.")
		return
	}
	var selected *iam.ProviderConnection
	for i := range connections {
		if connections[i].ID == strings.TrimSpace(r.PathValue("id")) && connections[i].Status == "active" {
			selected = &connections[i]
			break
		}
	}
	if selected == nil {
		writeError(w, 404, "provider connection not found")
		return
	}
	status := "unsupported"
	providerType := providers.CompanionDaemonType(config.Get().Providers[selected.ProviderID])
	adapter, supported := providers.Current().QuotaAdapterByID(providerType)
	if supported && providerType == providers.ExtensionTypeAntigravity {
		status = "unknown"
		state, found, stateErr := iam.ProviderAccountStateByConnection(selected.ID)
		if stateErr != nil {
			writeError(w, 500, "Credential store unavailable.")
			return
		}
		if found && r.Context().Err() == nil {
			result, fetchErr := adapter.Fetch(r.Context(), providers.QuotaFetchRequest{
				ConnectionID: selected.ID, CredentialRevision: state.CredentialRevision,
				PrincipalID: selected.PrincipalID, ProviderID: selected.ProviderID, ConnectionName: selected.Name,
			})
			if errors.Is(fetchErr, providers.ErrQuotaUnsupported) {
				status = "unsupported"
			} else if fetchErr == nil && len(result.Snapshots) > 0 && r.Context().Err() == nil {
				// The replacement transaction fences credential rotation/revocation.
				// Unknown responses leave both evidence and its original age intact.
				if err := iam.ReplaceProviderQuotaSnapshots(selected.ID, state.CredentialRevision, result.Snapshots); err == nil {
					status = "observed"
				}
			}
		}
	}
	advisories, err := providerQuotaAdvisories(principalID)
	if err != nil {
		writeError(w, 500, "Quota store unavailable.")
		return
	}
	writeJSON(w, 200, map[string]any{"status": status, "connection_id": selected.ID, "quota_advisories": advisories})
}
