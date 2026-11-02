package api

import (
	"net/http"
	"strings"

	"llmgw/internal/config"
	"llmgw/internal/iam"
)

func handleAdminKeyAccess(w http.ResponseWriter, r *http.Request) {
	if adminAuthed(w, r) {
		writeKeyAccessForOwner(w, r.PathValue("id"), "")
	}
}

func handleUserKeyAccess(w http.ResponseWriter, r *http.Request) {
	owner, ok := requireSSOUser(w, r)
	if ok {
		writeKeyAccessForOwner(w, r.PathValue("id"), owner.ID)
	}
}

// The inspector uses the same cached model listing, project rules and
// credential eligibility as /v1/models. It never resolves or reveals the key
// secret, spends quota, or contacts a provider.
func writeKeyAccessForOwner(w http.ResponseWriter, id, ownerID string) {
	key, found, err := iam.APIKeyByID(strings.TrimSpace(id))
	if err != nil {
		writeError(w, 500, "Identity store unavailable.")
		return
	}
	if !found || (ownerID != "" && key.PrincipalID != ownerID) {
		writeError(w, 404, "unknown key")
		return
	}
	status := key.Status
	if key.IsExpired() && status != "revoked" {
		status = "expired"
	}
	rows := []any{}
	if status == "active" {
		owner, ownerFound, ownerErr := iam.PrincipalByID(key.PrincipalID)
		project, projectFound, projectErr := iam.ProjectByID(key.ProjectID)
		role, member, memberErr := iam.MembershipRole(key.ProjectID, key.PrincipalID)
		if ownerErr != nil || projectErr != nil || memberErr != nil {
			writeError(w, 500, "Identity store unavailable.")
			return
		}
		if !ownerFound || !projectFound || !member || owner.Status != "active" || project.Status != "active" {
			status = "unavailable"
		} else {
			principal := &config.Principal{
				PrincipalID: key.PrincipalID, PrincipalKind: key.Kind,
				ProjectID: key.ProjectID, Project: project.Slug, Role: role,
				KeyID: key.ID, Token: "policy-inspection",
				AllowedRoutes: key.Policy.AllowedRoutes, RoutesOnly: key.Policy.RoutesOnly,
				AllowedProviders: key.Policy.AllowedProviders, AllowedModels: key.Policy.AllowedModels,
			}
			listed, listErr := buildModelList(principal)
			if listErr != nil {
				writeError(w, 500, "Model catalog unavailable.")
				return
			}
			rows = listed["data"].([]any)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"key_id": key.ID, "project_id": key.ProjectID, "principal_kind": key.Kind,
		"status": status, "data": rows,
	})
}
