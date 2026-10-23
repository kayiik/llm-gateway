package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
	"llmgw/internal/router"

	translation "github.com/kayiik/llm-translate/realtime"
	core "github.com/kayiik/llmgw-core"
	"github.com/kayiik/llmgw-core/realtimews"
)

// Native selection remains first. A request cannot broaden a route's explicit
// adaptation contract, and no target is retried after either peer is connected.
func resolveRealtimeWebsocketTarget(r *http.Request, p *config.Principal, requested string, settings *config.Settings) (router.Target, string, bool, int, string) {
	target, category, status, message := resolveRealtimeNativeTarget(r, p, requested, settings, realtimeWebsocketPath)
	if status == 0 {
		return target, category, false, 0, ""
	}
	if status != http.StatusBadRequest {
		return router.Target{}, category, false, status, message
	}
	mode, modeErr := requestedTransportMode(r)
	if modeErr != nil || mode == core.TransportRequirementNative || mode == core.TransportRequirementTransparent {
		return router.Target{}, category, false, status, message
	}
	resolution, err := resolveModel(r.Context(), requested, p)
	if err != nil {
		return router.Target{}, category, false, status, message
	}
	preference, err := requestedCompatibility(r)
	if err != nil {
		return router.Target{}, category, false, http.StatusBadRequest, "invalid compatibility preference"
	}
	allow, err := routeAdaptation(settings, resolution.Category, realtimeWebsocketPath, preference)
	if err != nil || !allow {
		return router.Target{}, category, false, status, message
	}
	targets, policyStatus, policyMessage := authorizeKeyPolicy(p, requested, resolution.Category, resolution.Targets)
	if policyStatus != 0 {
		return router.Target{}, category, false, policyStatus, policyMessage
	}
	for _, candidate := range targets {
		if providers.SupportsGeminiLiveTransport(settings, candidate.Provider) {
			return candidate, resolution.Category, true, 0, ""
		}
	}
	return router.Target{}, category, false, status, message
}

func handleGeminiRealtime(w http.ResponseWriter, r *http.Request, p *config.Principal, requested string, target router.Target, settings *config.Settings, generation uint64, started time.Time) {
	if r.Context().Err() != nil {
		recordFailureUsage(realtimeWebsocketEndpoint, requested, p, 499, "client_cancelled", started)
		return
	}
	upstreamURL, headers, err := providers.Current().GeminiLiveTarget(settings, target.Provider, callerOf(p))
	if err != nil {
		recordFailureUsage(realtimeWebsocketEndpoint, requested, p, http.StatusBadRequest, "provider_configuration", started)
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if config.Generation() != generation {
		writeError(w, http.StatusConflict, "Gateway configuration changed; retry with current routing policy.")
		return
	}
	if !admitRequest(w, realtimeWebsocketEndpoint, requested, p, "policy_or_route", started) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), nativeWebsocketLifetime)
	defer cancel()
	upstream, err := realtimews.Dial(ctx, upstreamURL, headers)
	if err != nil {
		if ctx.Err() != nil {
			recordGeminiRealtimeUsage(p, requested, target, 499, "session_cancelled", started)
			return
		}
		recordGeminiRealtimeUsage(p, requested, target, http.StatusBadGateway, "upstream_handshake", started)
		writeError(w, http.StatusBadGateway, "Gemini Live connection failed")
		return
	}
	defer upstream.Close()
	w.Header().Set("X-LLMGW-Usage-Scope", "unobserved_session")
	w.Header().Set("X-LLMGW-Realtime-Profile", "openai-ga-gemini-live-manual-pcm")
	client, err := realtimews.Upgrade(w, r)
	if err != nil {
		recordGeminiRealtimeUsage(p, requested, target, http.StatusBadRequest, "client_handshake", started)
		return
	}
	defer client.Close()
	code := bridgeGeminiRealtime(ctx, client, upstream, target.Model)
	recordGeminiRealtimeUsage(p, requested, target, http.StatusSwitchingProtocols, code, started)
}

func bridgeGeminiRealtime(parent context.Context, client, upstream *realtimews.Conn, model string) (code string) {
	type incoming struct {
		server bool
		raw    []byte
		err    error
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer func() {
		// Cancellation also closes the sockets; a resulting read error must not
		// win the select race and be attributed to an unrelated upstream failure.
		if parent.Err() != nil {
			code = "session_cancelled"
		}
	}()
	frames := make(chan incoming, 2)
	read := func(conn *realtimews.Conn, server bool) {
		for {
			raw, err := conn.Read()
			select {
			case frames <- incoming{server: server, raw: raw, err: err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}
	go read(client, false)
	go read(upstream, true)
	defer client.Close()
	defer upstream.Close()
	session := translation.New(model)
	for _, event := range session.Start() {
		if err := client.Write(event); err != nil {
			return "client_cancelled"
		}
	}
	for {
		select {
		case <-ctx.Done():
			return "session_cancelled"
		case event := <-frames:
			if event.err != nil {
				if event.server {
					return "upstream_closed"
				}
				return "client_cancelled"
			}
			var output translation.Output
			var err error
			if event.server {
				output, err = session.Server(event.raw)
			} else {
				output, err = session.Client(event.raw)
			}
			if err != nil {
				// No raw event, audio, transcript or credential enters HTTP logs.
				raw, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]any{"type": "invalid_request_error", "code": "unsupported_realtime_semantics", "message": err.Error()}})
				var semantic *translation.Error
				fatal := errors.As(err, &semantic) && semantic.RequiresClose
				if client.Write(raw) != nil || event.server || fatal {
					return "protocol_error"
				}
				continue
			}
			for _, raw := range output.Upstream {
				if err := upstream.Write(raw); err != nil {
					return "upstream_closed"
				}
			}
			for _, raw := range output.Downstream {
				if err := client.Write(raw); err != nil {
					return "client_cancelled"
				}
			}
		}
	}
}

func recordGeminiRealtimeUsage(p *config.Principal, requested string, target router.Target, status int, code string, started time.Time) {
	recordUsage(router.UsageRecord{
		RequestID: p.RequestID, Endpoint: realtimeWebsocketEndpoint, RequestedModel: requested,
		Provider: target.Provider, RoutedModel: target.Model, Project: p.Project, Key: p.Key,
		ProjectID: p.ProjectID, PrincipalID: p.PrincipalID, KeyID: p.KeyID,
		StatusCode: status, ErrorCode: code, LatencyMS: time.Since(started).Milliseconds(),
		SourceUsage: &iam.UsageEvidence{Version: 1, InputBasis: "unobserved_session", OutputBasis: "unobserved_session",
			InputIncomplete: true, OutputIncomplete: true, SelectionUnavailable: true, SelectedAttempt: -1,
			Attempts: []iam.UsageSource{{API: "gemini_live", Provider: target.Provider, Model: target.Model,
				Attempt: 1, Quality: "unknown", Cancelled: code == "client_cancelled" || code == "session_cancelled", Counts: map[string]iam.UsageSourceCount{}}}},
	})
}
