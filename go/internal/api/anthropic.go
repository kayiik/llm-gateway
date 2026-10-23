package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/providers"
	"llmgw/internal/router"

	core "github.com/kayiik/llmgw-core"

	"github.com/kayiik/llm-translate"
)

const maxAnthropicTokenCountBodyBytes = 32 << 20 // 32 MiB

type anthropicRequest struct {
	Model         string         `json:"model"`
	Messages      []any          `json:"messages"`
	MaxTokens     any            `json:"max_tokens"`
	System        any            `json:"system"`
	Tools         []any          `json:"tools"`
	ToolChoice    map[string]any `json:"tool_choice"`
	Stream        bool           `json:"stream"`
	Temperature   any            `json:"temperature"`
	TopP          any            `json:"top_p"`
	StopSequences []any          `json:"stop_sequences"`
	Metadata      any            `json:"metadata"`
	Thinking      map[string]any `json:"thinking"`
	OutputConfig  map[string]any `json:"output_config"`
	Raw           map[string]any `json:"-"`
}

func anthropicKwargs(req *anthropicRequest) providers.Kwargs {
	kw := providers.Kwargs{}
	if req.Temperature != nil {
		kw["temperature"] = req.Temperature
	}
	if req.MaxTokens != nil {
		kw["max_tokens"] = req.MaxTokens
	}
	if req.TopP != nil {
		kw["top_p"] = req.TopP
	}
	if len(req.StopSequences) > 0 {
		kw["stop"] = req.StopSequences
	}
	if req.Metadata != nil {
		kw["metadata"] = req.Metadata
	}
	if len(req.Thinking) > 0 {
		kw["thinking"] = req.Thinking
	}
	if len(req.OutputConfig) > 0 {
		kw["output_config"] = req.OutputConfig
		if effort, ok := req.OutputConfig["effort"].(string); ok && effort != "" {
			// Copilot's OpenAI-family chat and Responses endpoints express
			// Claude's output_config.effort as reasoning_effort/reasoning.effort.
			kw["reasoning_effort"] = effort
		}
	}
	if tools := translate.AnthropicToolsToOpenAI(req.Tools); tools != nil {
		kw["tools"] = tools
	}
	if tc := translate.AnthropicToolChoiceToOpenAI(req.ToolChoice); tc != nil {
		kw["tool_choice"] = tc
	}
	return kw
}

// messagesFallbackContext is fallbackContext for a Messages body. Its
// fallback_timeout_ms and affinity_key are the gateway's routing controls,
// not Messages fields, so they leave the body here: a native target would
// receive them, and the Chat adapter refuses a field it does not know.
func messagesFallbackContext(r *http.Request, raw map[string]any) context.Context {
	timeout := raw["fallback_timeout_ms"]
	affinity, _ := raw["affinity_key"].(string)
	delete(raw, "fallback_timeout_ms")
	delete(raw, "affinity_key")
	return fallbackContext(r, timeout, affinity)
}

func handleMessages(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	principal, ok := authed(w, r)
	if !ok {
		return
	}
	var req anthropicRequest
	var raw map[string]any
	if err := decodeInferenceBody(r.Body, &raw); err != nil {
		writeBodyError(w, err, 422, "invalid request body")
		return
	}
	encoded, _ := json.Marshal(raw)
	if json.Unmarshal(encoded, &req) != nil || req.Model == "" {
		writeError(w, 422, "model is required")
		return
	}
	transportMode, modeErr := requestedTransportMode(r)
	if modeErr != nil {
		writeError(w, http.StatusBadRequest, modeErr.Error())
		return
	}
	settings, generation := config.Snapshot()
	if pre := settings.GatewayPreamble; pre != "" && transportMode != "transparent" {
		raw["_llmgw_preamble"] = pre
	}
	ctx := providers.WithAnthropicClientHeaders(messagesFallbackContext(r, raw), r.Header)

	resolution, err := resolveModel(r.Context(), req.Model, principal)
	if err != nil {
		if _, ok := err.(*router.ModelNotFoundError); ok {
			recordFailureUsage("anthropic.messages", req.Model, principal, 404, "model_not_found", started)
			writeError(w, 404, err.Error())
			return
		}
		recordFailureUsage("anthropic.messages", req.Model, principal, 500, "route_config", started)
		writeError(w, 500, "Gateway is not configured for the requested model.")
		return
	}
	targets := resolution.Targets
	targets, polStatus, polMsg := authorizeKeyPolicy(principal, req.Model, resolution.Category, targets)
	if polStatus != 0 {
		recordFailureUsage("anthropic.messages", req.Model, principal, polStatus, "policy", started)
		writeError(w, polStatus, polMsg)
		return
	}
	r = r.WithContext(ctx)
	dispatchPreparedInference(w, r, principal, preparedInput{
		endpoint: "anthropic.messages", model: req.Model, surface: core.ModelSurfaceMessages,
		settings: settings, generation: generation, resolution: resolution, targets: targets,
		payload: raw, stream: req.Stream, started: started,
	})
}

// anthropicStreamErrorEvent is the Messages error event for a stream its
// upstream failed, typed by the upstream's status where it reported one.
func anthropicStreamErrorEvent(err error) string {
	return "event: error\ndata: " + jsonStr(map[string]any{
		"type": "error", "error": map[string]any{
			"type": anthropicErrorType(upstreamErrorStatus(err)), "message": "Upstream provider stream failed.",
		},
	}) + "\n\n"
}

// anthropicRecordEvent is the event a Messages stream record carries as its
// data, read as core's Anthropic reads it, or nil when the data is not a
// JSON object.
func anthropicRecordEvent(record string) map[string]any {
	var data []string
	for _, line := range strings.Split(record, "\n") {
		if field, value, _ := strings.Cut(strings.TrimSuffix(line, "\r"), ":"); field == "data" {
			data = append(data, strings.TrimPrefix(value, " "))
		}
	}
	var event map[string]any
	if json.Unmarshal([]byte(strings.Join(data, "\n")), &event) != nil {
		return nil
	}
	return event
}

func handleCountTokens(w http.ResponseWriter, r *http.Request) {
	principal, ok := authed(w, r)
	if !ok {
		return
	}
	var raw map[string]any
	r.Body = http.MaxBytesReader(w, r.Body, maxAnthropicTokenCountBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	if err := decoder.Decode(&raw); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		writeError(w, 422, "invalid request body")
		return
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		writeError(w, 422, "invalid request body")
		return
	}
	model, _ := raw["model"].(string)
	if strings.TrimSpace(model) == "" {
		writeError(w, 422, "model is required")
		return
	}
	resolution, err := resolveModel(r.Context(), model, principal)
	if err != nil {
		if _, ok := err.(*router.ModelNotFoundError); ok {
			writeError(w, 404, err.Error())
		} else {
			writeError(w, 500, "Gateway is not configured for the requested model.")
		}
		return
	}
	targets, status, message := authorizeKeyPolicy(principal, model, resolution.Category, resolution.Targets)
	if status != 0 {
		writeError(w, status, message)
		return
	}
	target := targets[0]
	if err := validateRouteIngress(resolution.Category, "/v1/messages/count_tokens"); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	provider, err := providers.GetProviderForPrincipal(target.Provider, callerOf(principal))
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	if providers.SupportsAnthropicTokenCount(provider) {
		count, err := providers.CountAnthropicTokensContext(r.Context(), provider, target.Model, raw, r.Header.Get("anthropic-version"), r.Header.Values("anthropic-beta"))
		if err != nil {
			if errors.Is(err, providers.ErrInvalidAnthropicTokenCount) {
				writeError(w, http.StatusBadGateway, "Upstream provider returned an invalid token count.")
				return
			}
			writeUpstreamError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"input_tokens": count})
		return
	}
	countPayload := map[string]any{}
	for _, field := range []string{"system", "messages", "tools", "tool_choice", "thinking", "output_config"} {
		if value, exists := raw[field]; exists {
			countPayload[field] = value
		}
	}
	compact, _ := json.Marshal(countPayload)
	tokens := max(1, estimatedTokens(len(compact)))
	w.Header().Set("X-LLMGW-Token-Count", "estimate")
	writeJSON(w, 200, map[string]any{"input_tokens": tokens})
}
