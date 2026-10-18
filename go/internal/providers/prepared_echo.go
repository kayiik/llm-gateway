package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"strings"

	translate "github.com/kayiik/llm-translate"
	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/config"
)

const preparedEchoCoreType = "internal_echo"

// Echo is an explicitly reviewed internal Chat service, not evidence inferred
// from a brand or a custom endpoint. No public core provider type is added.
func (rt *Runtime) echoPreparedVertical() coreVertical {
	return coreVertical{
		serves: func(_ *config.Settings, _ string, cfg *config.ProviderConfig) bool {
			return strings.EqualFold(strings.TrimSpace(cfg.Type), "echo")
		},
		provider:    func(*config.Settings, string) (core.Provider, error) { return preparedEchoProvider{}, nil },
		credentials: core.NewMemoryCredentialStore(),
	}
}

type preparedEchoProvider struct{}

func (preparedEchoProvider) NativeSurfaces(string) []core.ModelSurface {
	return []core.ModelSurface{core.ModelSurfaceChatCompletions}
}
func (preparedEchoProvider) PreservesWire(_ string, surface core.ModelSurface) bool {
	return surface == core.ModelSurfaceChatCompletions
}
func (preparedEchoProvider) ListModels(context.Context, *core.Credential) ([]core.ModelInfo, error) {
	var rows []core.ModelInfo
	for _, row := range (EchoProvider{}).ListModels() {
		rows = append(rows, core.ModelInfo{ID: row.ID, OwnedBy: "echo"})
	}
	return rows, nil
}

func decodePreparedPayload(request core.Request) (map[string]any, error) {
	media, _, err := mime.ParseMediaType(request.ContentType)
	if err != nil || media != core.ContentTypeJSON {
		return nil, &core.ProviderError{Message: "prepared request must be JSON", Class: core.ProviderErrorInvalidRequest}
	}
	decoder := json.NewDecoder(bytes.NewReader(request.Body))
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		return nil, &core.ProviderError{Message: "prepared request must be a JSON object", Class: core.ProviderErrorInvalidRequest, Cause: err}
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, &core.ProviderError{Message: "prepared request contains trailing JSON", Class: core.ProviderErrorInvalidRequest, Cause: err}
	}
	return payload, nil
}

func echoPreparedText(value any, path string) (string, []core.Loss) {
	loss := func(path string) core.Loss {
		return core.Loss{Path: path, Class: translate.LossUnsupported, Severity: translate.LossMaterial, Detail: "the internal Echo service supports ordinary text only"}
	}
	if value == nil {
		return "", nil
	}
	if text, ok := value.(string); ok {
		return text, nil
	}
	if parts, ok := value.([]any); ok {
		var text strings.Builder
		var losses []core.Loss
		for index, raw := range parts {
			part, _ := raw.(map[string]any)
			value, valid := part["text"].(string)
			if part["type"] != "text" || !valid {
				losses = append(losses, loss(fmt.Sprintf("%s.%d", path, index)))
				continue
			}
			text.WriteString(value)
			for key, value := range part {
				if key != "type" && key != "text" && value != nil {
					losses = append(losses, loss(fmt.Sprintf("%s.%d.%s", path, index, key)))
				}
			}
		}
		return text.String(), losses
	}
	return "", []core.Loss{loss(path)}
}

func (preparedEchoProvider) PrepareCall(_ context.Context, request core.Request, options core.CallPreparationOptions) (core.PreparedCall, error) {
	if request.Surface != core.ModelSurfaceChatCompletions {
		return nil, &core.SurfaceError{Surface: request.Surface, Model: request.Model}
	}
	payload, err := decodePreparedPayload(request)
	if err != nil {
		return nil, err
	}
	messages, ok := payload["messages"].([]any)
	if !ok && payload["messages"] != nil {
		return nil, &core.ProviderError{Message: "Echo messages must be an array", Class: core.ProviderErrorInvalidRequest}
	}
	var canonical []Message
	assessment := core.CallAssessment{Feasibility: core.SupportSupported, Evaluated: []string{"content", "tools", "schema", "billing", "replay"}}
	for index, raw := range messages {
		message, ok := raw.(map[string]any)
		if !ok {
			return nil, &core.ProviderError{Message: "Echo messages must be objects", Class: core.ProviderErrorInvalidRequest}
		}
		text, losses := echoPreparedText(message["content"], fmt.Sprintf("messages.%d.content", index))
		assessment.Losses = append(assessment.Losses, losses...)
		for _, field := range []string{"tool_calls", "tool_call_id", "function_call"} {
			if message[field] != nil {
				assessment.Losses = append(assessment.Losses, core.Loss{Path: fmt.Sprintf("messages.%d.%s", index, field), Class: translate.LossUnsupported, Severity: translate.LossMaterial, Detail: "the internal Echo service does not implement tool turns"})
			}
		}
		canonical = append(canonical, Message{"role": message["role"], "content": text})
	}
	for _, field := range []string{"tools", "tool_choice", "response_format", "reasoning", "thinking", "modalities", "audio", "prediction", "logprobs", "top_logprobs", "service_tier", "prompt_cache_key"} {
		if payload[field] != nil {
			assessment.Losses = append(assessment.Losses, core.Loss{Path: field, Class: translate.LossUnsupported, Severity: translate.LossMaterial, Detail: "the internal Echo service does not implement this control"})
		}
	}
	for _, field := range []string{"store", "background"} {
		if value, set := payload[field]; set && value != nil && value != false {
			assessment.Losses = append(assessment.Losses, core.Loss{Path: field, Class: translate.LossUnsupported, Severity: translate.LossMaterial, Detail: "the internal Echo service has no persisted/background state"})
		}
	}
	if len(assessment.Losses) > 0 {
		assessment.Feasibility = core.SupportUnsupported
	}
	inferred := translate.InferFidelityRequirements(payload)
	if inferred.Replay || options.Requirements.Replay {
		assessment.Feasibility = core.SupportUnsupported
		assessment.Losses = append(assessment.Losses, core.Loss{Path: "$", Class: translate.LossUnsupported, Severity: translate.LossMaterial, Detail: "the internal Echo service has no opaque continuation state contract"})
	}
	mode := options.Mode
	if mode == "" {
		mode = core.CallModeInvoke
	}
	transport := core.CallTransportJSON
	if mode == core.CallModeStream {
		transport = core.CallTransportSSE
	}
	requirements := options.Requirements
	requirements.Content = requirements.Content || inferred.Content
	requirements.Tools = requirements.Tools || inferred.Tools
	requirements.Schema = requirements.Schema || inferred.Schema
	requirements.Billing = requirements.Billing || inferred.Billing
	requirements.Replay = requirements.Replay || inferred.Replay
	d := core.CallDescription{Ingress: request.Surface, Model: request.Model, Mode: mode, Operation: core.ModelOperationChat, UpstreamAPI: core.UpstreamAPIChatCompletions, APIVersion: "internal-v1", Deployment: "internal_echo", WirePreserved: core.SupportSupported, UpstreamTransport: transport, OutputTransport: transport, Assessment: assessment, Requirements: requirements}
	return core.NewPreparedCall(d, func(ctx context.Context, _ *core.Credential) (core.Response, error) {
		if err := ctx.Err(); err != nil {
			return core.Response{}, err
		}
		record:=core.BeginSourceUsage(ctx,core.UpstreamAPIChatCompletions,translate.UsageDialectChat)
		response, err := (EchoProvider{}).Complete(request.Model, canonical, nil)
		if err != nil {
			record.Finish(translate.CompletionFailed,false)
			return core.Response{}, err
		}
		record.Merge(response["usage"]);record.Finish(translate.CompletionComplete,false)
		body, err := json.Marshal(response)
		return core.Response{Body: body, ContentType: core.ContentTypeJSON}, err
	},
		func(ctx context.Context, _ *core.Credential) (core.StreamIter, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		stream, err := (EchoProvider{}).Stream(request.Model, canonical, nil)
			if err != nil {
				return nil, err
			}
		record:=core.BeginSourceUsage(ctx,core.UpstreamAPIChatCompletions,translate.UsageDialectChat)
		return &preparedEchoStream{inner: stream, ctx: ctx,record:record}, nil
		}), nil
}

func (p preparedEchoProvider) Invoke(ctx context.Context, request core.Request) (core.Response, error) {
	call, err := p.PrepareCall(ctx, request, core.CallPreparationOptions{})
	if err != nil {
		return core.Response{}, err
	}
	return call.Invoke(ctx, request.Credential)
}
func (p preparedEchoProvider) Stream(ctx context.Context, request core.Request) (core.StreamIter, error) {
	call, err := p.PrepareCall(ctx, request, core.CallPreparationOptions{Mode: core.CallModeStream})
	if err != nil {
		return nil, err
	}
	return call.Stream(ctx, request.Credential)
}

type preparedEchoStream struct {
	inner StreamIter
	ctx   context.Context
	ended bool
	record *core.SourceUsageRecorder
}

func (s *preparedEchoStream) Next() ([]byte, error) {
	if err := s.ctx.Err(); err != nil {
		s.record.Finish(translate.CompletionPartial,true)
		return nil, err
	}
	if s.ended {
		return nil, io.EOF
	}
	if chunk, ok := s.inner.Next(); ok {
		return []byte("data: " + chunk + "\n\n"), nil
	}
	if err := s.inner.Err(); err != nil {
		s.record.Finish(translate.CompletionFailed,false)
		return nil, err
	}
	s.ended = true
	s.record.Finish(translate.CompletionComplete,false)
	return []byte("data: [DONE]\n\n"), nil
}
func (s *preparedEchoStream) Close() error {err:=s.inner.Close();if s.ctx.Err()!=nil{s.record.Finish(translate.CompletionPartial,true)}else{s.record.Finish(translate.CompletionPartial,false)};return err}
