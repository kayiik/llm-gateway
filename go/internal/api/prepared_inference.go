package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/providers"
	"llmgw/internal/router"

	translate "github.com/kayiik/llm-translate"
	core "github.com/kayiik/llmgw-core"
)

type preparedInput struct {
	endpoint, model string
	surface         core.ModelSurface
	settings        *config.Settings
	generation      uint64
	resolution      router.Resolution
	targets         []router.Target
	payload         map[string]any
	publicPayload   map[string]any
	stream          bool
	started         time.Time
}

func ingressPath(surface core.ModelSurface) string {
	switch surface {
	case core.ModelSurfaceChatCompletions:
		return "/v1/chat/completions"
	case core.ModelSurfaceResponses:
		return "/v1/responses"
	case core.ModelSurfaceMessages:
		return "/v1/messages"
	}
	return ""
}

func routeAdaptation(settings *config.Settings, category, ingress, preference string) (bool, error) {
	if category == "" {
		return preference == "allow", nil
	}
	endpoint := settings.Endpoints[category]
	if err := config.ValidateEndpointContract(endpoint); err != nil {
		return false, err
	}
	if len(endpoint.Ingress) > 0 && !slices.Contains(endpoint.Ingress, ingress) {
		return false, errors.New("the requested API is not declared in this route's ingress contract")
	}
	return preference != "deny" && endpoint.AllowAdaptation && slices.Contains(endpoint.Ingress, ingress), nil
}

func validateRouteIngress(category, ingress string) error {
	if category == "" {
		return nil
	}
	_, err := routeAdaptation(config.Get(), category, ingress, "deny")
	return err
}

func dispatchPreparedInference(w http.ResponseWriter, r *http.Request, principal *config.Principal, input preparedInput) {
	fail := func(status int, code, message string) {
		recordFailureUsage(input.endpoint, input.model, principal, status, code, input.started)
		writeError(w, status, message)
	}
	failUpstream := func(err error) {
		recordFailureUsage(input.endpoint, input.model, principal, upstreamErrorStatus(err), "upstream", input.started)
		writeUpstreamError(w, err)
	}
	if config.Generation() != input.generation {
		fail(http.StatusConflict, "configuration_changed", "Gateway configuration changed; retry with current routing policy.")
		return
	}
	mode, err := requestedTransportMode(r)
	if err != nil {
		fail(http.StatusBadRequest, "compatibility", err.Error())
		return
	}
	preference, err := requestedCompatibility(r)
	if err != nil {
		fail(http.StatusBadRequest, "compatibility", err.Error())
		return
	}
	allow, err := routeAdaptation(input.settings, input.resolution.Category, ingressPath(input.surface), preference)
	if err != nil {
		fail(http.StatusBadRequest, "route_ingress", err.Error())
		return
	}
	targets := input.targets
	if len(targets) == 0 {
		fail(http.StatusBadRequest, "compatibility", "No authorized route member supports the requested semantic features.")
		return
	}
	if mode == core.TransportRequirementTransparent {
		if input.stream {
			fail(http.StatusBadRequest, "transparent_stream", "Transparent streaming is not supported.")
			return
		}
		target, err := exactNativeTransparentTarget(input.model, ingressPath(input.surface), input.resolution, callerOf(principal))
		if err != nil {
			fail(http.StatusBadRequest, "transparent_contract", err.Error())
			return
		}
		if !slices.Contains(targets, target) {
			fail(http.StatusBadRequest, "transparent_contract", "The exact target cannot preserve this request.")
			return
		}
		targets = []router.Target{target}
		allow = false
	}
	body, err := json.Marshal(input.payload)
	if err != nil {
		fail(http.StatusBadRequest, "invalid_request", "Request cannot be encoded.")
		return
	}
	header := http.Header{}
	for _, name := range []string{"anthropic-version", "anthropic-beta"} {
		for _, value := range r.Header.Values(name) {
			header.Add(name, value)
		}
	}
	request := core.Request{Surface: input.surface, Model: input.model, Body: body, ContentType: core.ContentTypeJSON, Header: header}
	callMode := core.CallModeInvoke
	if input.stream {
		callMode = core.CallModeStream
	}
	policy := core.CallPolicy{AllowAdaptation: allow, RequireWirePreservation: mode == core.TransportRequirementTransparent, RequireIncremental: input.stream}
	options := router.PreparedOptions{Preparation: core.CallPreparationOptions{Mode: callMode, AllowAdaptation: allow}, Policy: policy, Generation: input.generation}
	ctx := providers.WithAnthropicClientHeaders(governed(r.Context(), principal), r.Header)
	prepared, err := router.Current().PrepareRequest(ctx, targets, callerOf(principal), request, options)
	if err != nil {
		if providers.IsConfig(err) {
			failUpstream(err)
		} else {
			fail(upstreamErrorStatus(err), "compatibility", err.Error())
		}
		return
	}
	// Preparation can await local credential reads. Recheck project/key policy
	// before consuming a slot, and never restore a target authorization removed.
	authorized, status, message := authorizeKeyPolicy(principal, input.model, input.resolution.Category, prepared.Targets())
	if status != 0 {
		fail(status, "policy", message)
		return
	}
	if !slices.Equal(authorized, prepared.Targets()) {
		fail(http.StatusConflict, "policy_changed", "Authorization changed during preparation; retry the request.")
		return
	}
	if config.Generation() != input.generation {
		fail(http.StatusConflict, "configuration_changed", "Gateway configuration changed; retry with current routing policy.")
		return
	}
	if !admitRequest(w, input.endpoint, input.model, principal, "policy", input.started) {
		return
	}
	if input.stream {
		stream, served, trace, err := prepared.Stream(ctx, input.model)
		setPreparedDiagnostics(w, input, prepared, served, trace, mode)
		if err != nil {
			if r.Context().Err() != nil {
				recordPreparedUsage(principal, input, prepared, served, nil, 499, "client_cancelled")
				return
			}
			recordPreparedUsage(principal, input, prepared, served, nil, upstreamErrorStatus(err), "upstream")
			writeUpstreamError(w, err)
			return
		}
		streamPreparedInference(w, r, stream, served, principal, input)
		return
	}
	response, served, trace, err := prepared.Invoke(ctx, input.model)
	setPreparedDiagnostics(w, input, prepared, served, trace, mode)
	if err != nil {
		if r.Context().Err() != nil {
			recordPreparedUsage(principal, input, prepared, served, nil, 499, "client_cancelled")
			return
		}
		recordPreparedUsage(principal, input, prepared, served, nil, upstreamErrorStatus(err), "upstream")
		writeUpstreamError(w, err)
		return
	}
	var value map[string]any
	decoder := json.NewDecoder(bytes.NewReader(response.Body))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		recordPreparedUsage(principal, input, prepared, served, nil, http.StatusBadGateway, "upstream_shape")
		writeError(w, http.StatusBadGateway, "Upstream returned an invalid response object.")
		return
	}
	if input.surface == core.ModelSurfaceChatCompletions && mode != core.TransportRequirementTransparent {
		normalizeChatResponseEnvelope(value)
	}
	if input.surface == core.ModelSurfaceResponses {
		publicPayload := input.publicPayload
		if publicPayload == nil {
			publicPayload = input.payload
		}
		if mode != core.TransportRequirementTransparent {
			sanitizeResponsesForCaller(value, publicPayload)
		}
	}
	recordPreparedUsage(principal, input, prepared, served, value, http.StatusOK, "")
	if mode == core.TransportRequirementTransparent {
		contentType := response.ContentType
		if contentType == "" {
			contentType = core.ContentTypeJSON
		}
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(response.Body)
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func setPreparedDiagnostics(w http.ResponseWriter, input preparedInput, prepared *router.PreparedRequest, served *router.Target, trace []router.AttemptTrace, mode core.TransportRequirement) {
	w.Header().Set("X-LLMGW-Attempts", fmt.Sprint(len(trace)))
	w.Header().Set("X-LLMGW-TTFB-Ms", fmt.Sprint(time.Since(input.started).Milliseconds()))
	if input.surface == core.ModelSurfaceChatCompletions {
		messages, _ := input.payload["messages"].([]providers.Message)
		setChatDiagnostics(w, input.started, messages, input.payload["tools"], trace)
	}
	if mode == core.TransportRequirementTransparent {
		w.Header().Set(transportModeHeader, core.TransportModeTransparent)
		return
	}
	if served == nil {
		return
	}
	for index, target := range prepared.Targets() {
		if target != *served {
			continue
		}
		description := prepared.Descriptions()[index]
		label := core.TransportModeNative
		if len(description.Conversions) > 0 || string(description.Ingress) != string(description.UpstreamAPI) {
			label = core.TransportModeTranslated
		}
		w.Header().Set(transportModeHeader, label)
		return
	}
}

type chatStreamCompletion struct {
	seen, finished map[int]bool
	expected       int
	done           bool
}

func (c *chatStreamCompletion) observe(value map[string]any) {
	if c.seen == nil {
		c.seen = map[int]bool{}
		c.finished = map[int]bool{}
	}
	choices, _ := value["choices"].([]any)
	for _, raw := range choices {
		choice, _ := raw.(map[string]any)
		index := firstInt(choice, "index")
		c.seen[index] = true
		if reason, _ := choice["finish_reason"].(string); reason != "" {
			c.finished[index] = true
		}
	}
}

func (c *chatStreamCompletion) complete() bool {
	if c.done {
		return true
	}
	if len(c.seen) == 0 || (c.expected > 0 && len(c.seen) < c.expected) {
		return false
	}
	for index := range c.seen {
		if !c.finished[index] {
			return false
		}
	}
	return true
}

func preparedEvent(frame []byte) (map[string]any, string) {
	var data []string
	for _, line := range strings.Split(string(frame), "\n") {
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	text := strings.Join(data, "\n")
	if text == "[DONE]" {
		return nil, text
	}
	var value map[string]any
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	_ = decoder.Decode(&value)
	return value, text
}

func streamPreparedInference(w http.ResponseWriter, r *http.Request, stream core.StreamIter, served *router.Target, principal *config.Principal, input preparedInput) {
	closeStream := sync.OnceValue(stream.Close)
	defer closeStream()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	meter := newStreamUsage(input.endpoint, input.model, principal, served, input.started, payloadBytes(input.payload["messages"]))
	meter.source, meter.closeSource = stream, closeStream
	if input.surface == core.ModelSurfaceResponses {
		meter.promptBytes = payloadBytes(input.payload["input"])
	}
	chat := chatStreamCompletion{expected: firstInt(input.payload, "n")}
	tools := chatToolStream{choices: map[int]*chatToolChoice{}}
	terminal, failed := false, false
	var streamError error
	var held strings.Builder
	responseID, responseSequence := "", 0
	for {
		if r.Context().Err() != nil {
			meter.cancelled()
			return
		}
		frame, err := stream.Next()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				streamError = err
			}
			break
		}
		value, text := preparedEvent(frame)
		kind, _ := value["type"].(string)
		switch input.surface {
		case core.ModelSurfaceChatCompletions:
			if value != nil {
				text = tools.normalize(text)
				frame = []byte("data: " + text + "\n\n")
				value, _ = preparedEvent(frame)
			}
			meter.chat(value)
			chat.observe(value)
			if text == "[DONE]" {
				chat.done = true
				terminal = true
			}
			failed = failed || value["error"] != nil
		case core.ModelSurfaceMessages:
			meter.anthropicEvent(value)
			terminal = terminal || kind == "message_stop"
			failed = failed || kind == "error"
		case core.ModelSurfaceResponses:
			if sequence := firstInt(value, "sequence_number"); sequence >= responseSequence {
				responseSequence = sequence + 1
			}
			if response, ok := value["response"].(map[string]any); ok {
				if id, ok := response["id"].(string); ok {
					responseID = id
				}
			}
			if response, ok := value["response"].(map[string]any); ok && input.publicPayload != nil {
				sanitizeResponsesForCaller(response, input.publicPayload)
				frame = []byte("data: " + jsonStr(value) + "\n\n")
			}
			if kind != "" && !strings.ContainsAny(kind, "\r\n") && !strings.HasPrefix(string(frame), "event:") {
				frame = append([]byte("event: "+kind+"\n"), frame...)
			}
			meter.responsesEvent(value)
			terminal = terminal || kind == "response.completed" || kind == "response.incomplete"
			failed = failed || kind == "error" || kind == "response.failed"
		}
		// A Messages stop reason is provisional until message_stop arrives.
		// Keep it out of a truncated stream while still observing its usage.
		if input.surface == core.ModelSurfaceMessages && (kind == "message_delta" || (kind == "ping" && held.Len() > 0)) {
			held.Write(frame)
			continue
		}
		if !failed && held.Len() > 0 {
			frame = append([]byte(held.String()), frame...)
			held.Reset()
		}
		var writeErr error
		if input.surface == core.ModelSurfaceChatCompletions && value != nil {
			writeErr = writeChatSSE(w, text)
		} else {
			writeErr = writeAndFlush(w, frame)
		}
		if writeErr != nil {
			meter.cancelled()
			return
		}
		if failed {
			meter.failed()
			return
		}
		if terminal {
			meter.completed()
			return
		}
	}
	if r.Context().Err() != nil {
		meter.cancelled()
		return
	}
	if input.surface == core.ModelSurfaceChatCompletions {
		terminal = chat.complete()
	}
	if streamError != nil || failed || !terminal {
		var err error
		if input.surface == core.ModelSurfaceResponses {
			payload := map[string]any{
				"type": "response.failed", "sequence_number": responseSequence,
				"response": translate.FailedResponseEnvelope(served.Model, responseID, "server_error", "Upstream provider stream failed.", input.publicPayload),
			}
			err = writeAndFlush(w, []byte("event: response.failed\ndata: "+jsonStr(payload)+"\n\n"))
		} else {
			err = writePreparedStreamError(w, input.surface)
		}
		if err != nil {
			meter.cancelled()
			return
		}
		meter.failed()
		return
	}
	meter.completed()
}

func writePreparedStreamError(w http.ResponseWriter, surface core.ModelSurface) error {
	switch surface {
	case core.ModelSurfaceMessages:
		return writeAndFlush(w, []byte(anthropicStreamErrorEvent(nil)))
	default:
		return writeAndFlush(w, []byte("data: "+jsonStr(providerErrorPayloadOpenAI())+"\n\n"))
	}
}
