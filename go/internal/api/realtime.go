package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
	"llmgw/internal/router"

	core "github.com/kayiik/llmgw-core"
)

const realtimeCallsPath = "/v1/realtime/calls"
const realtimeCallsEndpoint = "openai.realtime.calls"

func isRealtimeSignalingPath(path string) bool {
	return path == realtimeCallsPath || strings.HasPrefix(path, realtimeCallsPath+"/") ||
		path == "/realtime/calls" || strings.HasPrefix(path, "/realtime/calls/")
}

func readRealtimeForm(r *http.Request) (string, map[string]any, error) {
	reader, err := r.MultipartReader()
	if err != nil {
		return "", nil, err
	}
	fields := map[string]string{}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", nil, err
		}
		name := part.FormName()
		if _, duplicate := fields[name]; duplicate || (name != "sdp" && name != "session") {
			return "", nil, errors.New("realtime form fields must be sdp and session, each supplied once")
		}
		raw, err := io.ReadAll(part)
		if err != nil {
			return "", nil, err
		}
		fields[name] = string(raw)
	}
	var session map[string]any
	if strings.TrimSpace(fields["sdp"]) == "" || decodeInferenceBody(strings.NewReader(fields["session"]), &session) != nil || session == nil {
		return "", nil, errors.New("realtime signaling requires an SDP offer and a session JSON object")
	}
	model, _ := session["model"].(string)
	if session["type"] != "realtime" || strings.TrimSpace(model) == "" {
		return "", nil, errors.New("session.type must be realtime and session.model must name a target or route")
	}
	return fields["sdp"], session, nil
}

func realtimeMultipart(sdp string, session map[string]any) ([]byte, string, error) {
	rawSession, err := json.Marshal(session)
	if err != nil {
		return nil, "", err
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, field := range []struct{ name, contentType, value string }{
		{"sdp", "application/sdp", sdp}, {"session", core.ContentTypeJSON, string(rawSession)},
	} {
		part, err := writer.CreatePart(textproto.MIMEHeader{
			"Content-Disposition": {`form-data; name="` + field.name + `"`}, "Content-Type": {field.contentType},
		})
		if err != nil {
			return nil, "", err
		}
		if _, err := io.WriteString(part, field.value); err != nil {
			return nil, "", err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return body.Bytes(), writer.FormDataContentType(), nil
}

// Catalog declarations constrain native selection while current. A cache miss
// remains unknown: the configured compatible endpoint validates its model,
// without a model-name heuristic, a discovery call or cross-API adaptation.
func realtimeNativeModel(provider, model string, caller core.Caller) bool {
	return realtimeNativeSurface(provider, model, realtimeCallsPath, caller)
}

func realtimeNativeSurface(provider, model, surface string, caller core.Caller) bool {
	row, found := providers.CatalogCachedLookupForPrincipal(provider, model, caller)
	if !found {
		return true
	}
	return realtimeCatalogSurfaceSupport(row, providers.CatalogRefreshedAtForPrincipal(provider, caller), time.Now(), surface) != core.SupportUnsupported
}

func realtimeCatalogSupport(row providers.ModelInfo, refreshed time.Time, now time.Time) core.Support {
	return realtimeCatalogSurfaceSupport(row, refreshed, now, realtimeCallsPath)
}

func realtimeCatalogSurfaceSupport(row providers.ModelInfo, refreshed time.Time, now time.Time, requested string) core.Support {
	if len(row.SupportedSurfaces) == 0 {
		return core.SupportUnknown
	}
	static := row.TypedCapabilities != nil && row.TypedCapabilities.SchemaVersion == core.ModelCapabilitiesSchemaVersion &&
		(row.TypedCapabilities.Provenance.Source == core.ModelCapabilitySourceRegistryStatic || row.TypedCapabilities.Provenance.Source == core.ModelCapabilitySourceOperatorOverride)
	if !static {
		if row.TypedCapabilities != nil && row.TypedCapabilities.Freshness.Status(now) == core.FreshnessExpired {
			return core.SupportUnknown
		}
		if refreshed.IsZero() || now.Sub(refreshed) >= transportCatalogFreshness {
			return core.SupportUnknown
		}
	}
	for _, surface := range row.SupportedSurfaces {
		if strings.TrimPrefix(surface, "/v1") == strings.TrimPrefix(requested, "/v1") {
			return core.SupportSupported
		}
	}
	return core.SupportUnsupported
}

func resolveRealtimeTarget(r *http.Request, p *config.Principal, requested string, settings *config.Settings) (router.Target, string, int, string) {
	return resolveRealtimeNativeTarget(r, p, requested, settings, realtimeCallsPath)
}

func resolveRealtimeNativeTarget(r *http.Request, p *config.Principal, requested string, settings *config.Settings, ingress string) (router.Target, string, int, string) {
	resolution, err := resolveModel(r.Context(), requested, p)
	if err != nil {
		var missing *router.ModelNotFoundError
		if errors.As(err, &missing) {
			return router.Target{}, "", http.StatusNotFound, err.Error()
		}
		return router.Target{}, "", http.StatusInternalServerError, "Gateway is not configured for the requested model."
	}
	targets, status, message := authorizeKeyPolicy(p, requested, resolution.Category, resolution.Targets)
	if status != 0 {
		return router.Target{}, "", status, message
	}
	if err := validateRouteIngress(resolution.Category, ingress); err != nil {
		return router.Target{}, "", http.StatusBadRequest, err.Error()
	}
	for _, target := range targets {
		if cfg := settings.Providers[target.Provider]; cfg != nil && !cfg.Disabled && providers.SupportsRealtimeHTTPTransport(target.Provider) && realtimeNativeSurface(target.Provider, target.Model, ingress, callerOf(p)) {
			return target, resolution.Category, 0, ""
		}
	}
	return router.Target{}, "", http.StatusBadRequest, "no route member serves the requested native compatible realtime transport"
}

func realtimeCallLocation(value, base string) string {
	location, err := url.Parse(value)
	upstream, baseErr := url.Parse(base)
	if err != nil || baseErr != nil || location.User != nil || location.RawQuery != "" || location.Fragment != "" ||
		(location.IsAbs() && (location.Scheme != upstream.Scheme || location.Host != upstream.Host)) || (!location.IsAbs() && location.Host != "") {
		return ""
	}
	_, id, found := strings.Cut(location.Path, "/realtime/calls/")
	if !found || id == "" || len(id) > 256 || id == "." || id == ".." || strings.ContainsAny(id, "/\\") {
		return ""
	}
	return realtimeCallsPath + "/" + url.PathEscape(id)
}

func recordRealtimeUsage(p *config.Principal, requested string, target router.Target, status int, code string, started time.Time) {
	// The peer connection bypasses this HTTP exchange. Preserve absence instead
	// of claiming a zero-token session. The known signaling attempt has no
	// measured counters or inferred media-completion quality.
	recordUsage(router.UsageRecord{
		RequestID: p.RequestID, Endpoint: realtimeCallsEndpoint, RequestedModel: requested,
		Provider: target.Provider, RoutedModel: target.Model, Project: p.Project, Key: p.Key,
		ProjectID: p.ProjectID, PrincipalID: p.PrincipalID, KeyID: p.KeyID,
		StatusCode: status, ErrorCode: code, LatencyMS: time.Since(started).Milliseconds(),
		SourceUsage: &iam.UsageEvidence{Version: 1, InputBasis: "unobserved_session", OutputBasis: "unobserved_session",
			InputIncomplete: true, OutputIncomplete: true, SelectionUnavailable: true, SelectedAttempt: -1,
			Attempts: []iam.UsageSource{{API: "realtime_calls", Provider: target.Provider, Model: target.Model,
				Attempt: 1, Quality: "unknown", Cancelled: code == "client_cancelled", Counts: map[string]iam.UsageSourceCount{}}}},
	})
}

func handleRealtimeCalls(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	principal, ok := authed(w, r)
	if !ok {
		return
	}
	settings, generation := (config.Source{}).Snapshot()
	fail := func(model string, status int, code, message string) {
		recordFailureUsage(realtimeCallsEndpoint, model, principal, status, code, started)
		writeError(w, status, message)
	}
	mode, err := requestedTransportMode(r)
	if err != nil || mode == core.TransportRequirementTransparent {
		fail("", http.StatusBadRequest, "transport_policy", "realtime signaling requires native transport without transparent mode")
		return
	}
	sdp, session, err := readRealtimeForm(r)
	if err != nil {
		status := writeBodyError(w, err, http.StatusBadRequest, "invalid realtime form: supply one sdp offer and one realtime session JSON object with a model")
		recordFailureUsage(realtimeCallsEndpoint, "", principal, status, "invalid_body", started)
		return
	}
	requested := strings.TrimSpace(session["model"].(string))
	target, category, status, message := resolveRealtimeTarget(r, principal, requested, settings)
	if status != 0 {
		fail(requested, status, "policy_or_route", message)
		return
	}
	session["model"] = target.Model
	body, contentType, err := realtimeMultipart(sdp, session)
	if err != nil {
		fail(requested, http.StatusBadRequest, "invalid_body", "realtime session could not be encoded")
		return
	}
	base, headers, ready := providers.ProviderHTTPTarget(target.Provider, callerOf(principal))
	if !ready {
		fail(requested, http.StatusInternalServerError, "provider_configuration", "realtime provider request could not be prepared")
		return
	}
	if _, status, message := authorizeKeyPolicy(principal, requested, category, []router.Target{target}); status != 0 {
		fail(requested, status, "policy_or_route", message)
		return
	}
	if r.Context().Err() != nil {
		recordFailureUsage(realtimeCallsEndpoint, requested, principal, 499, "client_cancelled", started)
		return
	}
	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, base+"/realtime/calls", bytes.NewReader(body))
	if err != nil {
		fail(requested, http.StatusInternalServerError, "provider_configuration", "realtime provider request could not be prepared")
		return
	}
	copyAuthHeaders(upstream, headers, true)
	upstream.Header.Set("Content-Type", contentType)
	if config.Generation() != generation {
		fail(requested, http.StatusConflict, "configuration_changed", "Gateway configuration changed; retry with current routing policy.")
		return
	}
	if !admitRequest(w, realtimeCallsEndpoint, requested, principal, "policy_or_route", started) {
		return
	}
	// Creating a peer session is not repeatable. Never follow a redirect or
	// retry/fail over after dispatch, even if no answer was received.
	response, err := audioClient.Do(upstream)
	if err != nil {
		if r.Context().Err() != nil {
			recordRealtimeUsage(principal, requested, target, 499, "client_cancelled", started)
			return
		}
		recordRealtimeUsage(principal, requested, target, http.StatusBadGateway, "upstream", started)
		writeError(w, http.StatusBadGateway, "realtime signaling upstream error")
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		result := readAPIProxyResponse(response, "realtime signaling")
		if retryAfter := safeRetryAfter(response.Header.Get("Retry-After")); retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		recordRealtimeUsage(principal, requested, target, result.status, result.errorCode, started)
		writeUpstreamError(w, result.err)
		return
	}
	defer response.Body.Close()
	answer, readErr := io.ReadAll(io.LimitReader(response.Body, defaultMaxRequestBodyBytes+1))
	if r.Context().Err() != nil {
		recordRealtimeUsage(principal, requested, target, 499, "client_cancelled", started)
		return
	}
	answerType := response.Header.Get("Content-Type")
	mediaType, _, typeErr := mime.ParseMediaType(answerType)
	if readErr != nil || len(answer) > defaultMaxRequestBodyBytes ||
		(answerType != "" && (typeErr != nil || (mediaType != "application/sdp" && mediaType != "text/plain"))) ||
		(!bytes.HasPrefix(answer, []byte("v=0\r\n")) && !bytes.HasPrefix(answer, []byte("v=0\n"))) {
		recordRealtimeUsage(principal, requested, target, http.StatusBadGateway, "invalid_upstream_response", started)
		writeError(w, http.StatusBadGateway, "realtime provider returned an invalid SDP answer")
		return
	}
	if answerType == "" {
		answerType = "application/sdp"
	}
	w.Header().Set("Content-Type", answerType)
	w.Header().Set(transportModeHeader, "native")
	w.Header().Set("X-LLMGW-Usage-Scope", "signaling")
	if locations := response.Header.Values("Location"); len(locations) == 1 {
		if location := realtimeCallLocation(locations[0], base); location != "" {
			w.Header().Set("Location", location)
		}
	}
	w.WriteHeader(response.StatusCode)
	if n, err := w.Write(answer); err != nil || n != len(answer) || r.Context().Err() != nil {
		recordRealtimeUsage(principal, requested, target, 499, "client_cancelled", started)
		return
	}
	recordRealtimeUsage(principal, requested, target, response.StatusCode, "", started)
}
