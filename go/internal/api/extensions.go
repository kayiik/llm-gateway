package api

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"maps"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/diagnostics"
	"llmgw/internal/iam"
	"llmgw/internal/providers"

	"github.com/kayiik/llmgw-core/extension"
)

// Extensions are the companion daemons the gateway reaches the providers
// they serve through. gateway.db stores them, each with its shared secret
// sealed; the running gateway reaches them through the published settings,
// which PublishExtensions brings in step with gateway.db after every change
// these handlers make.

const (
	// extensionCheckTimeout bounds a check of one extension, both of its
	// requests, so a daemon that does not answer still lets the listing load.
	extensionCheckTimeout = 5 * time.Second
	// minimumExtensionVersion is the oldest daemon release whose protocol
	// the gateway relies on; a check reports an older one as outdated.
	minimumExtensionVersion = "0.0.4"
	// maxExtensionCheckReason bounds the reason a failed check reports.
	maxExtensionCheckReason = 300
	// maxExtensionInfoBytes bounds the info answer a check reads, as the
	// extension client bounds it.
	maxExtensionInfoBytes = 1 << 20
)

// The codes of a failed check.
const (
	// extensionSecretRefused: the daemon refused the secret.
	extensionSecretRefused = "secret_refused"
	// extensionNotAnExtension: something answered, but not the extension
	// protocol.
	extensionNotAnExtension = "not_an_extension"
	// extensionNoAnswer: nothing answered in time.
	extensionNoAnswer = "no_answer"
	// extensionCheckFailed: any other failure.
	extensionCheckFailed = "error"
)

// extensionMutationMu serializes the changes to extensions, and to the
// providers that name one, with their publication. The published
// extensions then follow gateway.db's order of changes, and no provider
// comes to name an extension a delete removes meanwhile.
var extensionMutationMu sync.Mutex

// retiredExtensionVariables configured the single companion daemon before
// extensions. The gateway no longer reads them, but says when one is set.
var retiredExtensionVariables = []string{"LLMGW_EXTENSION_URL", "LLMGW_EXTENSION_SECRET"}

// extensionProvider is a configured provider an extension serves, as the
// type the companion daemon serves it as.
type extensionProvider struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Disabled bool   `json:"disabled,omitempty"`
}

// extensionStatus is what a check of an extension found.
type extensionStatus struct {
	Probed    bool   `json:"probed"`
	Reachable bool   `json:"reachable"`
	LatencyMS int64  `json:"latency_ms"`
	Version   string `json:"version"`
	// Served are the providers the daemon reports it serves.
	Served []extension.ProviderInfo `json:"served"`
	// Error says why a check failed, without the secret or anything the
	// daemon answered, and ErrorCode which failure it was.
	Error     string `json:"error"`
	ErrorCode string `json:"error_code"`
	CheckedAt string `json:"checked_at"`
	// Unauthenticated reports a daemon that answers without the secret
	// too, and so serves anyone who reaches it.
	Unauthenticated bool `json:"unauthenticated"`
	// Outdated reports a daemon older than minimumExtensionVersion.
	Outdated bool `json:"outdated"`
}

// extensionView is an extension as the administrator's API shows it, never
// with its secret.
type extensionView struct {
	iam.Extension
	SecretSet bool                `json:"secret_set"`
	Providers []extensionProvider `json:"providers"`
	Status    *extensionStatus    `json:"status,omitempty"`
}

// extensionViewOf shows stored, which always has a secret: the store
// refuses an extension without one.
func extensionViewOf(settings *config.Settings, stored iam.Extension) extensionView {
	return extensionView{Extension: stored, SecretSet: true, Providers: providersServedBy(settings, stored.ID)}
}

// providersServedBy returns the configured providers that resolve to the
// extension id under settings, by ID: those that name it, and those that
// name none while it is the only extension.
func providersServedBy(settings *config.Settings, id string) []extensionProvider {
	served := []extensionProvider{}
	for _, providerID := range providers.CompanionDaemonProviders(settings) {
		if ext, err := providers.ExtensionFor(settings, providerID); err != nil || ext.ID != id {
			continue
		}
		cfg := settings.Providers[providerID]
		served = append(served, extensionProvider{ID: providerID, Type: providers.CompanionDaemonType(cfg), Disabled: cfg.Disabled})
	}
	return served
}

// providerExtensions maps each configured provider the companion daemon
// serves to the extension that serves it, or to "" when none does.
func providerExtensions(settings *config.Settings) map[string]string {
	resolved := map[string]string{}
	for _, providerID := range providers.CompanionDaemonProviders(settings) {
		ext, _ := providers.ExtensionFor(settings, providerID)
		resolved[providerID] = ext.ID
	}
	return resolved
}

// PublishExtensions puts the extensions gateway.db stores into the
// published settings, where a provider the companion daemon serves resolves
// the one that serves it. The gateway publishes them when it starts and
// after every change to one. Publishing advances the settings' generation,
// so the core Runtime rebuilds the providers it built for an extension's
// previous address or secret. An extension whose secret does not decrypt is
// published as unusable, which its providers report on each request, rather
// than keeping the others from being used.
func PublishExtensions() error {
	stored, err := iam.ExtensionCredentials()
	if err != nil {
		return err
	}
	published := make(map[string]config.Extension, len(stored))
	for _, credential := range stored {
		ext := config.Extension{ID: credential.ID, URL: credential.URL, Secret: credential.Secret}
		if credential.Err != nil {
			ext.Unusable = credential.Err.Error()
		}
		published[credential.ID] = ext
	}
	config.Update(func(s *config.Settings) { s.Extensions = published })
	return nil
}

// republishExtensions publishes the extensions after a change was stored.
// Should that fail, the change is stored but the running gateway is not
// using it, which the answer says.
func republishExtensions(w http.ResponseWriter) bool {
	if err := PublishExtensions(); err != nil {
		log.Printf("publish extensions: %v", err)
		writeError(w, http.StatusInternalServerError,
			"The extension change was saved, but the running gateway could not load it; restart the gateway to use it.")
		return false
	}
	return true
}

// writeExtensionStoreError answers a change the extension store refused,
// or could not make. named is the ID the request named, if any.
func writeExtensionStoreError(w http.ResponseWriter, err error, named string) {
	var invalid *iam.InvalidExtensionError
	switch {
	case errors.As(err, &invalid):
		writeError(w, http.StatusBadRequest, invalid.Message)
	case errors.Is(err, iam.ErrExtensionExists):
		writeError(w, http.StatusConflict, fmt.Sprintf("extension %q already exists; choose another id", strings.TrimSpace(named)))
	case errors.Is(err, iam.ErrExtensionNotFound):
		writeError(w, http.StatusNotFound, "unknown extension")
	case errors.Is(err, iam.ErrCredentialEncryptionNotConfigured):
		// The same refusal as any other credential's without the key.
		writeError(w, http.StatusBadRequest,
			"LLMGW_CREDENTIAL_ENCRYPTION_KEY is required to store an extension's secret, which the gateway never stores in plaintext")
	default:
		log.Printf("extension store: %v", err)
		writeError(w, http.StatusInternalServerError, "Extension store unavailable.")
	}
}

// extensionBody is an extension as an administrator sends it. A field an
// update leaves out stays as it is.
type extensionBody struct {
	ID     *string `json:"id"`
	Name   *string `json:"name"`
	URL    *string `json:"url"`
	Secret *string `json:"secret"`
}

// decodeExtensionBody reads an extension, its address as the extension
// client takes it, or answers why it cannot.
func decodeExtensionBody(w http.ResponseWriter, r *http.Request) (extensionBody, bool) {
	var body extensionBody
	if !decodeBody(r, &body) {
		writeError(w, http.StatusBadRequest, "invalid body")
		return body, false
	}
	if body.URL != nil {
		address, err := providers.ExtensionAddress(*body.URL)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return body, false
		}
		body.URL = &address
	}
	return body, true
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// GET /admin/api/extensions lists the extensions with the providers each
// serves and what a check of each found, all checked at once.
func (s *server) handleListExtensions(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	stored, err := iam.ExtensionCredentials()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Extension store unavailable.")
		return
	}
	settings := config.Get()
	views := make([]extensionView, len(stored))
	var checks sync.WaitGroup
	for index, credential := range stored {
		views[index] = extensionViewOf(settings, credential.Extension)
		checks.Go(func() {
			status := checkStoredExtension(r.Context(), credential)
			views[index].Status = &status
		})
	}
	checks.Wait()
	writeJSON(w, http.StatusOK, map[string]any{
		"extensions": views, "minimum_version": minimumExtensionVersion,
		"legacy_environment": len(retiredExtensionVariablesSet()) > 0,
	})
}

// POST /admin/api/extensions adds an extension, whose ID is derived from its
// name unless the body names one.
func (s *server) handleCreateExtension(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	body, ok := decodeExtensionBody(w, r)
	if !ok {
		return
	}
	extensionMutationMu.Lock()
	defer extensionMutationMu.Unlock()
	created, err := iam.CreateExtension(iam.ExtensionCreate{
		ID: optionalString(body.ID), Name: optionalString(body.Name), URL: optionalString(body.URL), Secret: optionalString(body.Secret),
	})
	if err != nil {
		writeExtensionStoreError(w, err, optionalString(body.ID))
		return
	}
	pinned, err := pinProvidersToTheOnlyExtension(created.ID)
	if err != nil {
		if _, deleteErr := iam.DeleteExtension(created.ID); deleteErr != nil {
			log.Printf("remove the extension %q after its providers could not be pinned: %v", created.ID, deleteErr)
		}
		writeConfigSaveError(w, "The providers the existing extension serves could not be kept with it, so the extension was not added.", err)
		return
	}
	detail := map[string]any{"changed": []string{"name", "url", "secret"}}
	if len(pinned) > 0 {
		detail["pinned"] = pinned
	}
	auditAdmin(r, "extension.create", "extension", created.ID, detail)
	if !republishExtensions(w) {
		return
	}
	writeJSON(w, http.StatusCreated, extensionViewOf(config.Get(), created))
}

// pinProvidersToTheOnlyExtension names the only published extension in each
// provider the companion daemon serves that names none, before the extension
// added stops it being the only one. Such a provider has been served by that
// extension and would otherwise be left to choose between two, and serve no
// request until an administrator chose. It returns the providers it pinned,
// sorted. The extension added is not published yet, so the published
// settings still hold only the one that served them.
func pinProvidersToTheOnlyExtension(added string) ([]string, error) {
	settings := config.Get()
	if len(settings.Extensions) != 1 {
		return nil, nil
	}
	var only string
	for id := range settings.Extensions {
		only = id
	}
	if only == added {
		return nil, nil
	}
	var pinned []string
	for _, providerID := range providers.CompanionDaemonProviders(settings) {
		if cfg := settings.Providers[providerID]; cfg != nil && strings.TrimSpace(cfg.Extension) == "" {
			pinned = append(pinned, providerID)
		}
	}
	if len(pinned) == 0 {
		return nil, nil
	}
	slices.Sort(pinned)
	if _, err := config.UpdateAndSave(func(s *config.Settings) error {
		for _, providerID := range pinned {
			if cfg := s.Providers[providerID]; cfg != nil && strings.TrimSpace(cfg.Extension) == "" {
				cfg.Extension = only
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return pinned, nil
}

// PATCH /admin/api/extensions/{id} changes the fields the body carries; a
// secret it leaves out stays as it is. An extension's ID never changes:
// providers name it, and its secret is bound to it.
func (s *server) handleUpdateExtension(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	body, ok := decodeExtensionBody(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if body.ID != nil && strings.TrimSpace(*body.ID) != id {
		writeError(w, http.StatusBadRequest, "an extension's id does not change; add an extension with the new id instead")
		return
	}
	extensionMutationMu.Lock()
	defer extensionMutationMu.Unlock()
	updated, changed, err := iam.UpdateExtension(id, iam.ExtensionUpdate{Name: body.Name, URL: body.URL, Secret: body.Secret})
	if err != nil {
		writeExtensionStoreError(w, err, id)
		return
	}
	if len(changed) > 0 {
		auditAdmin(r, "extension.update", "extension", updated.ID, map[string]any{"changed": changed})
		if !republishExtensions(w) {
			return
		}
	}
	writeJSON(w, http.StatusOK, extensionViewOf(config.Get(), updated))
}

// DELETE /admin/api/extensions/{id} removes an extension no provider
// resolves to. One that serves a provider, which names it or has no other
// extension, stays, and the answer names the providers to move first.
func (s *server) handleDeleteExtension(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	id := r.PathValue("id")
	extensionMutationMu.Lock()
	defer extensionMutationMu.Unlock()
	if _, found, err := iam.ExtensionByID(id); err != nil {
		writeError(w, http.StatusInternalServerError, "Extension store unavailable.")
		return
	} else if !found {
		writeError(w, http.StatusNotFound, "unknown extension")
		return
	}
	if served := providersServedBy(config.Get(), id); len(served) > 0 {
		ids := make([]string, 0, len(served))
		for _, provider := range served {
			ids = append(ids, provider.ID)
		}
		message := providers.SanitizeDiagnosticTextLimit(fmt.Sprintf(
			"extension %q serves provider(s) %s; name another extension for them, or delete them, first",
			id, strings.Join(ids, ", ")), 2048)
		refusal := errorPayload(message, httpExceptionType(http.StatusConflict), itoa(http.StatusConflict), w.Header().Get(requestIDHeader))
		refusal["providers"] = ids
		writeJSON(w, http.StatusConflict, refusal)
		return
	}
	if _, err := iam.DeleteExtension(id); err != nil {
		writeError(w, http.StatusInternalServerError, "Extension store unavailable.")
		return
	}
	auditAdmin(r, "extension.delete", "extension", id, map[string]any{"existed": true})
	if !republishExtensions(w) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /admin/api/extensions/check checks a daemon an administrator has not
// saved yet, as the console's "Check connection" does.
func (s *server) handleCheckExtensionAddress(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	var body struct {
		URL    string `json:"url"`
		Secret string `json:"secret"`
	}
	if !decodeBody(r, &body) {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	address, err := providers.ExtensionAddress(body.URL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	secret := strings.TrimSpace(body.Secret)
	if secret == "" {
		writeError(w, http.StatusBadRequest, "a shared secret is required: enter the one the daemon was started with")
		return
	}
	writeJSON(w, http.StatusOK, checkExtension(r.Context(), address, secret))
}

// POST /admin/api/extensions/{id}/check checks a saved extension.
func (s *server) handleCheckExtension(w http.ResponseWriter, r *http.Request) {
	if !adminAuthed(w, r) {
		return
	}
	credential, found, err := iam.ExtensionCredentialByID(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Extension store unavailable.")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "unknown extension")
		return
	}
	writeJSON(w, http.StatusOK, checkStoredExtension(r.Context(), credential))
}

// checkStoredExtension checks a stored extension, unless its secret does not
// decrypt: a check without the secret would check a daemon the gateway
// cannot use.
func checkStoredExtension(ctx context.Context, credential iam.ExtensionCredential) extensionStatus {
	if credential.Err != nil {
		return extensionStatus{
			Served: []extension.ProviderInfo{}, ErrorCode: extensionCheckFailed,
			Error: checkReason("the extension's secret cannot be used: "+credential.Err.Error(), ""),
		}
	}
	return checkExtension(ctx, credential.URL, credential.Secret)
}

// checkExtension asks the daemon at address what it serves, with secret and
// then, once it answered, without it, within extensionCheckTimeout. It
// follows no redirect, as the extension client follows none: a daemon behind
// one is a daemon the gateway does not reach.
func checkExtension(ctx context.Context, address, secret string) extensionStatus {
	status := extensionStatus{Probed: true, Served: []extension.ProviderInfo{}, CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	ctx, cancel := context.WithTimeout(ctx, extensionCheckTimeout)
	defer cancel()
	transport := &http.Transport{}
	if shared, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = shared.Clone()
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	started := time.Now()
	info, code, reason := requestExtensionInfo(ctx, client, address, secret)
	status.LatencyMS = time.Since(started).Milliseconds()
	if code != "" {
		status.ErrorCode, status.Error = code, checkReason(reason, secret)
		return status
	}
	status.Reachable, status.Version = true, info.Version
	if info.Providers != nil {
		status.Served = info.Providers
	}
	status.Outdated = extensionOutdated(info.Version)
	if _, code, _ := requestExtensionInfo(ctx, client, address, ""); code == "" {
		status.Unauthenticated = true
	}
	return status
}

// requestExtensionInfo asks the daemon at address for its info, with secret
// unless it is empty. A failure returns its code and a reason that repeats
// neither the address, which may carry credentials, nor what the daemon
// answered, which may echo the secret.
func requestExtensionInfo(ctx context.Context, client *http.Client, address, secret string) (extension.InfoResponse, string, string) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address+extension.PathPrefix+"info", nil)
	if err != nil {
		return extension.InfoResponse{}, extensionCheckFailed, "the address cannot be requested"
	}
	request.Header.Set("Accept", "application/json")
	if secret != "" {
		request.Header.Set("Authorization", "Bearer "+secret)
	}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return extension.InfoResponse{}, extensionNoAnswer, fmt.Sprintf("the extension did not answer within %s", extensionCheckTimeout)
		}
		return extension.InfoResponse{}, extensionNoAnswer, "the extension did not answer: " + transportReason(err)
	}
	defer response.Body.Close()
	switch status := response.StatusCode; {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return extension.InfoResponse{}, extensionSecretRefused, fmt.Sprintf("the extension refused the secret (HTTP %d)", status)
	case status == http.StatusNotFound:
		return extension.InfoResponse{}, extensionNotAnExtension,
			"the address answered HTTP 404 for the extension protocol's info route: it is not a companion daemon"
	case status >= 300 && status <= 399:
		return extension.InfoResponse{}, extensionCheckFailed, fmt.Sprintf(
			"the address answered with a redirect (HTTP %d), which the gateway does not follow: enter the address the daemon listens at", status)
	case status < 200 || status > 299:
		return extension.InfoResponse{}, extensionCheckFailed, fmt.Sprintf("the extension answered HTTP %d", status)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxExtensionInfoBytes+1))
	if err != nil {
		return extension.InfoResponse{}, extensionNoAnswer, "the extension's answer broke off"
	}
	// An info answer is an object that lists the providers the daemon
	// serves; any other answer is something else listening there.
	var fields map[string]json.RawMessage
	var info extension.InfoResponse
	if len(raw) > maxExtensionInfoBytes || json.Unmarshal(raw, &fields) != nil || fields["providers"] == nil ||
		json.Unmarshal(raw, &info) != nil {
		return extension.InfoResponse{}, extensionNotAnExtension,
			"the address answered, but not with the extension protocol's info: it is not a companion daemon"
	}
	return info, "", ""
}

// transportReason is why a request got no answer, without the URL Go's
// error repeats.
func transportReason(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	return err.Error()
}

// checkReason bounds and sanitizes the reason a check failed. The reasons
// are the gateway's own words, but the secret is struck out all the same.
func checkReason(reason, secret string) string {
	if secret != "" {
		reason = strings.ReplaceAll(reason, secret, diagnostics.Redacted)
	}
	return diagnostics.SanitizeTextLimit(reason, maxExtensionCheckReason)
}

// semver is a semantic version's release numbers and pre-release
// identifiers.
type semver struct {
	release    [3]uint64
	prerelease []string
}

// parseSemver reads MAJOR.MINOR.PATCH, numbers without leading zeros, with
// an optional "v" before it, an optional pre-release after "-" and optional
// build metadata after "+", which does not count.
func parseSemver(raw string) (semver, bool) {
	text := strings.TrimPrefix(strings.TrimSpace(raw), "v")
	text, _, _ = strings.Cut(text, "+")
	text, prerelease, hasPrerelease := strings.Cut(text, "-")
	parts := strings.Split(text, ".")
	if len(parts) != 3 {
		return semver{}, false
	}
	var version semver
	for index, part := range parts {
		number, ok := semverNumber(part)
		if !ok {
			return semver{}, false
		}
		version.release[index] = number
	}
	if hasPrerelease {
		version.prerelease = strings.Split(prerelease, ".")
		for _, identifier := range version.prerelease {
			if identifier == "" || strings.Trim(identifier, "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-") != "" {
				return semver{}, false
			}
		}
	}
	return version, true
}

// semverNumber reads a numeric identifier: digits without a leading zero.
func semverNumber(part string) (uint64, bool) {
	if part == "" || (len(part) > 1 && part[0] == '0') || strings.Trim(part, "0123456789") != "" {
		return 0, false
	}
	number, err := strconv.ParseUint(part, 10, 64)
	return number, err == nil
}

// compareSemver orders a and b by semantic version precedence: release
// numbers first, then a pre-release before its release, then pre-releases
// by their identifiers, numeric ones by value and before alphanumeric ones,
// and the shorter list first when one is the other's start.
func compareSemver(a, b semver) int {
	for index := range a.release {
		if order := cmp.Compare(a.release[index], b.release[index]); order != 0 {
			return order
		}
	}
	if len(a.prerelease) == 0 || len(b.prerelease) == 0 {
		// A release has no identifiers, and comes after its pre-releases.
		return cmp.Compare(len(b.prerelease), len(a.prerelease))
	}
	for index := 0; index < len(a.prerelease) && index < len(b.prerelease); index++ {
		left, right := a.prerelease[index], b.prerelease[index]
		leftNumber, leftNumeric := semverNumber(left)
		rightNumber, rightNumeric := semverNumber(right)
		var order int
		switch {
		case leftNumeric && rightNumeric:
			order = cmp.Compare(leftNumber, rightNumber)
		case leftNumeric:
			order = -1
		case rightNumeric:
			order = 1
		default:
			order = strings.Compare(left, right)
		}
		if order != 0 {
			return order
		}
	}
	return cmp.Compare(len(a.prerelease), len(b.prerelease))
}

// extensionOutdated reports a version that is a semantic version below
// minimumExtensionVersion. Anything else, such as "dev" for a daemon built
// from source, is not outdated: the gateway cannot tell.
func extensionOutdated(version string) bool {
	current, ok := parseSemver(version)
	minimum, _ := parseSemver(minimumExtensionVersion)
	return ok && compareSemver(current, minimum) < 0
}

// retiredExtensionVariablesSet names the retired variables that are still
// set. Only that they are set counts: the gateway uses neither value, and
// the secret's is a credential.
func retiredExtensionVariablesSet() []string {
	var set []string
	for _, name := range retiredExtensionVariables {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			set = append(set, name)
		}
	}
	return set
}

// extensionWarnings says what keeps the providers the companion daemon
// serves from working: the retired variables still set, which suggests a
// daemon the gateway no longer reaches; the enabled providers no extension
// serves; and the extensions whose secret the gateway cannot use.
func extensionWarnings(settings *config.Settings) []string {
	var warnings []string
	if set := retiredExtensionVariablesSet(); len(set) > 0 {
		subject, verb, pronoun, object := set[0], "is", "it", "the variable"
		if len(set) > 1 {
			subject, verb, pronoun, object = strings.Join(set, " and "), "are", "them", "the variables"
		}
		warnings = append(warnings, fmt.Sprintf(
			"%s %s set, but the gateway no longer reads %s: add the companion daemon as an extension in the console "+
				"(Providers -> Extensions) or with POST /admin/api/extensions, then remove %s",
			subject, verb, pronoun, object))
	}
	var unserved []string
	for _, providerID := range providers.CompanionDaemonProviders(settings) {
		if settings.Providers[providerID].Disabled {
			continue
		}
		if _, err := providers.ExtensionFor(settings, providerID); err != nil {
			unserved = append(unserved, providerID)
		}
	}
	if len(unserved) > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"no extension serves provider(s) %s, which the companion daemon serves: add the daemon as an extension "+
				"in the console (Providers -> Extensions) or with POST /admin/api/extensions, or choose which extension serves each",
			strings.Join(unserved, ", ")))
	}
	for _, id := range slices.Sorted(maps.Keys(settings.Extensions)) {
		if unusable := settings.Extensions[id].Unusable; unusable != "" {
			warnings = append(warnings, fmt.Sprintf("extension %q cannot be used: %s", id, unusable))
		}
	}
	return warnings
}
