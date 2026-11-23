package api

import (
	"errors"
	"net/http"
	"strings"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
)

type principalBody struct {
	Kind            string `json:"kind"`
	ExternalSubject string `json:"external_subject"`
	Email           string `json:"email"`
	DisplayName     string `json:"display_name"`
}

func handleCreatePrincipal(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	var body principalBody
	if !decodeBody(r, &body) {
		writeError(w, 400, "invalid body")
		return
	}
	principal, err := iam.CreatePrincipalNamedByAdmin(
		strings.TrimSpace(body.Kind), strings.TrimSpace(body.ExternalSubject),
		strings.TrimSpace(body.Email), strings.TrimSpace(body.DisplayName),
	)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	auditAdmin(r, "principal.create", "principal", principal.ID, map[string]any{"kind": principal.Kind})
	writeJSON(w, 201, principal)
}

// POST /admin/api/principals/{id}/rename names a principal. The name sticks:
// sign-ins no longer refresh it from the identity provider.
func handleRenamePrincipal(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	var body struct {
		DisplayName string `json:"display_name"`
	}
	if !decodeBody(r, &body) {
		writeError(w, 400, "invalid body")
		return
	}
	before, after, err := iam.RenamePrincipal(r.PathValue("id"), body.DisplayName)
	if errors.Is(err, iam.ErrPrincipalNotFound) {
		writeError(w, 404, "unknown principal")
		return
	}
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	auditAdmin(r, "principal.rename", "principal", after.ID, map[string]any{"from": before.DisplayName, "to": after.DisplayName})
	writeJSON(w, 200, after)
}

type statusBody struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func handlePrincipalStatus(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	var body statusBody
	if !decodeBody(r, &body) {
		writeError(w, 400, "invalid body")
		return
	}
	if err := iam.SetPrincipalStatus(strings.TrimSpace(body.ID), strings.TrimSpace(body.Status)); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	auditAdmin(r, "principal.status", "principal", body.ID, map[string]any{"status": body.Status})
	writeJSON(w, 200, map[string]any{"ok": true})
}

type projectBody struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

func requireAdminProject(w http.ResponseWriter, r *http.Request, id string) (iam.Project, bool) {
	if !adminAuthed(w, r) {
		return iam.Project{}, false
	}
	id = strings.TrimSpace(id)
	if id == "" {
		writeError(w, 400, "project_id required")
		return iam.Project{}, false
	}
	project, found, err := iam.ProjectByID(id)
	if err != nil {
		writeError(w, 500, "Identity store unavailable.")
		return iam.Project{}, false
	}
	if !found {
		writeError(w, 404, "unknown project")
		return iam.Project{}, false
	}
	return project, true
}

func writeProjectChangeError(w http.ResponseWriter, err error, status int, message string) {
	if errors.Is(err, iam.ErrProjectNotFound) {
		writeError(w, 404, "unknown project")
		return
	}
	writeError(w, status, message)
}

func handleListProjects(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	items, err := iam.ListProjects()
	if err != nil {
		writeError(w, 500, "Identity store unavailable.")
		return
	}
	writeJSON(w, 200, map[string]any{"projects": items})
}

func handleCreateProject(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	var body projectBody
	if !decodeBody(r, &body) {
		writeError(w, 400, "invalid body")
		return
	}
	project, err := iam.CreateProject(body.Slug, body.Name)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	auditAdmin(r, "project.create", "project", project.ID, map[string]any{"slug": project.Slug})
	writeJSON(w, 201, project)
}

func handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	_, err := iam.DeleteProject(id, newAdminAuditEvent(r, nil))
	switch {
	case errors.Is(err, iam.ErrProjectNotFound):
		writeError(w, http.StatusNotFound, "unknown project")
	case errors.Is(err, iam.ErrProjectNotDisabled):
		writeError(w, http.StatusConflict, "Disable the project before deleting it.")
	case err != nil:
		writeError(w, http.StatusInternalServerError, "Identity store unavailable.")
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleProjectStatus(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	var body statusBody
	if !decodeBody(r, &body) {
		writeError(w, 400, "invalid body")
		return
	}
	if err := iam.SetProjectStatus(strings.TrimSpace(body.ID), strings.TrimSpace(body.Status)); err != nil {
		writeProjectChangeError(w, err, 400, err.Error())
		return
	}
	auditAdmin(r, "project.status", "project", body.ID, map[string]any{"status": body.Status})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func handleGetProjectPolicy(w http.ResponseWriter, r *http.Request) {
	project, ok := requireAdminProject(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	policy, err := iam.GetProjectPolicy(project.ID)
	if err != nil {
		writeError(w, 500, "Project policy store unavailable.")
		return
	}
	writeJSON(w, 200, policy)
}

func handleSetProjectPolicy(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	var policy iam.KeyPolicy
	if !decodeBody(r, &policy) {
		writeError(w, 400, "invalid body")
		return
	}
	result, err := iam.SetProjectPolicy(strings.TrimSpace(r.PathValue("id")), policy)
	if err != nil {
		writeProjectChangeError(w, err, 400, err.Error())
		return
	}
	auditAdmin(r, "project.policy", "project", result.ProjectID, nil)
	writeJSON(w, 200, result)
}

type credentialBindingBody struct {
	ProviderID    string `json:"provider_id"`
	PrincipalKind string `json:"principal_kind"`
	CredentialID  string `json:"credential_id"`
	Status        string `json:"status"`
}

func handleListProviderCredentialBindings(w http.ResponseWriter, r *http.Request) {
	project, ok := requireAdminProject(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	items, err := iam.ListProviderCredentialBindings(project.ID)
	if err != nil {
		writeError(w, 500, "Credential binding store unavailable.")
		return
	}
	writeJSON(w, 200, map[string]any{"bindings": items})
}

func handleSetProviderCredentialBinding(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	var body credentialBindingBody
	if !decodeBody(r, &body) {
		writeError(w, 400, "invalid body")
		return
	}
	binding, err := iam.SetProviderCredentialBinding(
		strings.TrimSpace(r.PathValue("id")), strings.TrimSpace(body.ProviderID),
		strings.TrimSpace(body.PrincipalKind), strings.TrimSpace(body.CredentialID),
	)
	if err != nil {
		writeProjectChangeError(w, err, 400, err.Error())
		return
	}
	providers.ResetProviders()
	providers.ForgetCatalogForProject(binding.ProviderID, binding.ProjectID)
	auditAdmin(r, "provider_credential_binding.set", "project", binding.ProjectID, map[string]any{
		"provider_id": binding.ProviderID, "principal_kind": binding.PrincipalKind,
		"credential_id": binding.CredentialID,
	})
	writeJSON(w, 200, binding)
}

func handleProviderCredentialBindingStatus(w http.ResponseWriter, r *http.Request) {
	project, ok := requireAdminProject(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	var body credentialBindingBody
	if !decodeBody(r, &body) {
		writeError(w, 400, "invalid body")
		return
	}
	providerID := strings.TrimSpace(body.ProviderID)
	principalKind := strings.TrimSpace(body.PrincipalKind)
	status := strings.TrimSpace(body.Status)
	if err := iam.SetProviderCredentialBindingStatus(
		project.ID, providerID, principalKind, status,
	); err != nil {
		writeProjectChangeError(w, err, 400, err.Error())
		return
	}
	providers.ResetProviders()
	providers.ForgetCatalogForProject(providerID, project.ID)
	auditAdmin(r, "provider_credential_binding.status", "project", project.ID, map[string]any{
		"provider_id": providerID, "principal_kind": principalKind, "status": status,
	})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func handleImportSharedProviderCredential(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	providerID := strings.TrimSpace(r.PathValue("id"))
	provider, ok := config.Get().Providers[providerID]
	if !ok {
		writeError(w, 404, "unknown provider")
		return
	}
	if !strings.EqualFold(provider.Type, "github_copilot") {
		writeError(w, 400, "configured shared credential import is supported only for github_copilot")
		return
	}
	var body struct {
		Source string `json:"source"`
	}
	if !decodeBody(r, &body) || strings.TrimSpace(body.Source) != "configured" {
		writeError(w, 400, "source must be 'configured'")
		return
	}
	secret := config.Get().GithubCopilotOAuthToken
	if secret == "" {
		writeError(w, 400, "configured provider credential is unavailable")
		return
	}
	credential, err := iam.PutGatewayProviderCredential(providerID, "github_oauth", secret)
	if err != nil {
		writeError(w, 500, "Could not encrypt provider credential.")
		return
	}
	providers.ResetProviders()
	providers.ForgetInheritedCatalogs(providerID)
	auditAdmin(r, "provider_credential.import", "provider_credential", credential.ID, map[string]any{
		"provider_id": providerID, "source": "configured",
	})
	writeJSON(w, 200, map[string]any{"ok": true, "credential": credential})
}

func handleProviderCredentialStatus(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	var body struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if !decodeBody(r, &body) {
		writeError(w, 400, "invalid body")
		return
	}
	credentialID := strings.TrimSpace(body.ID)
	credential, ok, err := iam.ProviderCredentialByID(credentialID)
	if err != nil {
		writeError(w, 500, "Credential store unavailable.")
		return
	}
	if !ok {
		writeError(w, 404, "provider credential not found")
		return
	}
	owner, ok, err := iam.PrincipalByID(credential.PrincipalID)
	if err != nil {
		writeError(w, 500, "Credential owner store unavailable.")
		return
	}
	if !ok {
		writeError(w, 500, "Provider credential owner is unavailable.")
		return
	}
	if err := iam.SetProviderCredentialStatus(credentialID, strings.TrimSpace(body.Status)); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	providers.ResetProviders()
	if owner.Kind == "system" {
		providers.ForgetInheritedCatalogs(credential.ProviderID)
	} else {
		providers.ForgetCatalogForPrincipal(credential.ProviderID, credential.PrincipalID)
	}
	auditAdmin(r, "provider_credential.status", "provider_credential", body.ID, map[string]any{
		"provider_id": credential.ProviderID, "status": body.Status,
	})
	writeJSON(w, 200, map[string]any{"ok": true})
}

type membershipBody struct {
	ProjectID   string `json:"project_id"`
	PrincipalID string `json:"principal_id"`
	Role        string `json:"role"`
}

func handleListMemberships(w http.ResponseWriter, r *http.Request) {
	project, ok := requireAdminProject(w, r, r.URL.Query().Get("project_id"))
	if !ok {
		return
	}
	items, err := iam.ListMemberships(project.ID)
	if err != nil {
		writeError(w, 500, "Identity store unavailable.")
		return
	}
	writeJSON(w, 200, map[string]any{"memberships": items})
}

func handleSetMembership(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	var body membershipBody
	if !decodeBody(r, &body) {
		writeError(w, 400, "invalid body")
		return
	}
	if err := iam.SetMembership(
		strings.TrimSpace(body.ProjectID), strings.TrimSpace(body.PrincipalID),
		strings.TrimSpace(body.Role),
	); err != nil {
		writeProjectChangeError(w, err, 400, err.Error())
		return
	}
	auditAdmin(r, "membership.set", "project", body.ProjectID, map[string]any{
		"principal_id": body.PrincipalID, "role": body.Role,
	})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func handleDeleteMembership(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	projectID := strings.TrimSpace(r.URL.Query().Get("project_id"))
	principalID := strings.TrimSpace(r.URL.Query().Get("principal_id"))
	if projectID == "" || principalID == "" {
		writeError(w, 400, "project_id and principal_id required")
		return
	}
	if err := iam.RemoveMembership(projectID, principalID); err != nil {
		writeProjectChangeError(w, err, 500, "Identity store unavailable.")
		return
	}
	auditAdmin(r, "membership.remove", "project", projectID, map[string]any{"principal_id": principalID})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func handleListPrincipalCredentials(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	items, err := iam.ListProviderCredentials(strings.TrimSpace(r.PathValue("id")))
	if err != nil {
		writeError(w, 500, "Credential store unavailable.")
		return
	}
	writeJSON(w, 200, map[string]any{"credentials": items})
}

func handlePrincipalCopilotRevoke(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	principalID := strings.TrimSpace(r.PathValue("id"))
	if err := iam.RevokeProviderCredential(principalID, "copilot"); err != nil {
		writeError(w, 404, oauthErrorText(err.Error()))
		return
	}
	providers.ForgetProviderForPrincipal("copilot", principalID)
	providers.ForgetCatalogForPrincipal("copilot", principalID)
	auditAdmin(r, "oauth_connection.revoke", "principal", principalID, map[string]any{"provider": "copilot"})
	writeJSON(w, 200, map[string]any{"ok": true})
}
