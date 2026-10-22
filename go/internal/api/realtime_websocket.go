package api

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
	"llmgw/internal/router"

	core "github.com/kayiik/llmgw-core"
)

const realtimeWebsocketPath = "/v1/realtime"
const realtimeWebsocketEndpoint = "openai.realtime.websocket"

func handleRealtimeWebsocket(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	principal, ok := authed(w, r)
	if !ok {
		return
	}
	settings, generation := (config.Source{}).Snapshot()
	fail := func(model string, status int, code, message string) {
		recordFailureUsage(realtimeWebsocketEndpoint, model, principal, status, code, started)
		writeError(w, status, message)
	}
	mode, err := requestedTransportMode(r)
	if err != nil || mode == core.TransportRequirementTransparent {
		fail("", http.StatusBadRequest, "transport_policy", "realtime WebSocket does not support transparent mode")
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	requested := strings.TrimSpace(query.Get("model"))
	if err != nil || len(query) != 1 || len(query["model"]) != 1 || requested == "" || !validWebsocketUpgrade(r) ||
		len(r.Header.Values("Sec-WebSocket-Protocol")) != 0 || r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
		fail(requested, http.StatusBadRequest, "invalid_handshake", "supply a WebSocket upgrade with exactly one model query parameter; subprotocol authentication is not supported")
		return
	}
	target, category, adapted, status, message := resolveRealtimeWebsocketTarget(r, principal, requested, settings)
	if status != 0 {
		fail(requested, status, "policy_or_route", message)
		return
	}
	if adapted {
		handleGeminiRealtime(w, r, principal, requested, target, settings, generation, started)
		return
	}
	base, headers, ready := providers.ProviderHTTPTarget(target.Provider, callerOf(principal))
	upstream, err := url.Parse(base + "/realtime")
	if !ready || err != nil || (upstream.Scheme != "http" && upstream.Scheme != "https") || upstream.Host == "" || upstream.User != nil || upstream.RawQuery != "" || upstream.Fragment != "" {
		fail(requested, http.StatusInternalServerError, "provider_configuration", "realtime provider request could not be prepared")
		return
	}
	upstream.RawQuery = url.Values{"model": {target.Model}}.Encode()
	if _, status, message := authorizeKeyPolicy(principal, requested, category, []router.Target{target}); status != 0 {
		fail(requested, status, "policy_or_route", message)
		return
	}
	if r.Context().Err() != nil {
		recordFailureUsage(realtimeWebsocketEndpoint, requested, principal, 499, "client_cancelled", started)
		return
	}
	if config.Generation() != generation {
		fail(requested, http.StatusConflict, "configuration_changed", "Gateway configuration changed; retry with current routing policy.")
		return
	}
	if !admitRequest(w, realtimeWebsocketEndpoint, requested, principal, "policy_or_route", started) {
		return
	}
	status, code := relayNativeWebsocket(w, r, upstream, headers, nativeWebsocketLifetime)
	recordUsage(router.UsageRecord{
		RequestID: principal.RequestID, Endpoint: realtimeWebsocketEndpoint, RequestedModel: requested,
		Provider: target.Provider, RoutedModel: target.Model, Project: principal.Project, Key: principal.Key,
		ProjectID: principal.ProjectID, PrincipalID: principal.PrincipalID, KeyID: principal.KeyID,
		StatusCode: status, ErrorCode: code, LatencyMS: time.Since(started).Milliseconds(),
		SourceUsage: &iam.UsageEvidence{Version: 1, InputBasis: "unobserved_session", OutputBasis: "unobserved_session",
			InputIncomplete: true, OutputIncomplete: true, SelectionUnavailable: true, SelectedAttempt: -1,
			Attempts: []iam.UsageSource{{API: "realtime_websocket", Provider: target.Provider, Model: target.Model,
				Attempt: 1, Quality: "unknown", Cancelled: code == "client_cancelled", Counts: map[string]iam.UsageSourceCount{}}}},
	})
}
