package api

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/router"

	translate "github.com/kayiik/llm-translate"
	core "github.com/kayiik/llmgw-core"
)

func sourceCounts(observation core.SourceUsageObservation) map[string]translate.CountObservation {
	u, d := observation.Usage, observation.Details
	return map[string]translate.CountObservation{
		"input_tokens": u.InputTokens, "output_tokens": u.OutputTokens, "total_tokens": u.TotalTokens,
		"base_input_tokens": u.BaseInputTokens, "cache_read_tokens": u.CacheReadTokens, "cache_write_tokens": u.CacheWriteTokens,
		"reasoning_tokens": u.ReasoningTokens, "cache_write_5m_tokens": u.CacheWrite5mTokens, "cache_write_1h_tokens": u.CacheWrite1hTokens,
		"input_audio_tokens": d.InputAudioTokens, "output_audio_tokens": d.OutputAudioTokens,
		"accepted_prediction_tokens": d.AcceptedPredictionTokens, "rejected_prediction_tokens": d.RejectedPredictionTokens,
		"web_search_requests": d.WebSearchRequests, "web_fetch_requests": d.WebFetchRequests,
	}
}

func usageSource(observation core.SourceUsageObservation) iam.UsageSource {
	result := iam.UsageSource{
		API: string(observation.API), Dialect: string(observation.Usage.Dialect), Provider: observation.Instance, Model: observation.Model,
		Attempt: observation.Attempt, Quality: string(observation.Usage.Quality), Cancelled: observation.Cancelled,
		Counts:       map[string]iam.UsageSourceCount{},
		Invalid:      len(observation.Usage.Issues) > 0,
		RawTruncated: observation.Usage.RawTruncated,
	}
	bounded := func(value string, limit int) string {
		if len(value) > limit {
			result.Truncated = true
			return value[:limit]
		}
		return value
	}
	result.API = bounded(result.API, 64)
	result.Provider, result.Model = bounded(result.Provider, 256), bounded(result.Model, 512)
	for name, count := range sourceCounts(observation) {
		presence := string(count.Presence)
		if presence == "" {
			presence = string(translate.CountAbsent)
		}
		if count.Presence == translate.CountInvalid {
			result.Invalid = true
		}
		result.Counts[name] = iam.UsageSourceCount{Value: count.Value, Presence: presence, Provenance: string(count.Provenance), Path: bounded(count.Path, 96)}
	}
	// Only fixed scalar usage fields enter durable raw evidence. Recognized
	// nested details already have typed counts; arbitrary strings/objects may
	// contain provider payloads and are deliberately excluded.
	for name, raw := range observation.Usage.Raw {
		switch name {
		case "prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
			"promptTokenCount", "candidatesTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount", "toolUsePromptTokenCount",
			"prompt_eval_count", "eval_count", "total_duration", "load_duration", "prompt_eval_duration", "eval_duration":
			if len(raw) <= 64 && json.Valid(raw) {
				var scalar any
				decoder := json.NewDecoder(bytes.NewReader(raw))
				decoder.UseNumber()
				if decoder.Decode(&scalar) == nil {
					switch scalar.(type) {
					case json.Number, bool, nil:
						if result.Raw == nil {
							result.Raw = map[string]json.RawMessage{}
						}
						result.Raw[name] = append(json.RawMessage(nil), raw...)
						continue
					}
				}
			}
		}
		result.RawTruncated = true
	}
	return result
}

func sourceCount(count translate.CountObservation, fallback int, basis string) (int, string, bool) {
	if count.Presence == translate.CountInvalid {
		return 0, "invalid", true
	}
	if count.Presence != translate.CountPresent || count.Provenance == translate.UsageSynthetic {
		return fallback, basis, false
	}
	if count.Value < 0 || count.Value > int64(math.MaxInt) {
		return 0, "invalid", true
	}
	return int(count.Value), string(count.Provenance), false
}

func sourceUsageSnapshot(value any, input, output int, inputBasis, outputBasis string) (int, int, *iam.UsageEvidence, *router.Target) {
	observation, available := core.SourceUsageOf(value)
	history := core.SourceUsageHistoryOf(value)
	if !available && len(history.Attempts) == 0 {
		return input, output, nil, nil
	}
	evidence := &iam.UsageEvidence{Version: 1, InputBasis: inputBasis, OutputBasis: outputBasis}
	if len(history.Attempts) == 0 {
		history.Attempts = []core.SourceUsageObservation{observation}
	}
	// Keep a bounded diagnostic history; cumulative frames within an attempt
	// have already been merged by the source collector and are never added twice.
	if len(history.Attempts) > 8 {
		history.Attempts = history.Attempts[len(history.Attempts)-8:]
		history.Truncated = true
	}
	evidence.HistoryTruncated = history.Truncated
	selected := -1
	for _, attempt := range history.Attempts {
		if attempt.API == observation.API && attempt.Instance == observation.Instance && attempt.Model == observation.Model && attempt.Attempt == observation.Attempt {
			selected = len(evidence.Attempts)
		}
		evidence.Attempts = append(evidence.Attempts, usageSource(attempt))
	}
	if !available {
		// A later target can fail before making a native call. Retain earlier
		// history without attributing its counts to that unobserved target.
		evidence.SelectedAttempt, evidence.SelectionUnavailable = -1, true
		return input, output, evidence, nil
	}
	if selected < 0 {
		if len(evidence.Attempts) == 8 {
			evidence.Attempts = evidence.Attempts[1:]
			evidence.HistoryTruncated = true
		}
		selected = len(evidence.Attempts)
		evidence.Attempts = append(evidence.Attempts, usageSource(observation))
	}
	evidence.SelectedAttempt = selected
	var invalidInput, invalidOutput bool
	input, evidence.InputBasis, invalidInput = sourceCount(observation.Usage.InputTokens, input, inputBasis)
	output, evidence.OutputBasis, invalidOutput = sourceCount(observation.Usage.OutputTokens, output, outputBasis)
	if observation.Usage.OutputTokens.Presence == translate.CountPresent && observation.Usage.Quality != translate.CompletionComplete && !invalidOutput {
		evidence.OutputIncomplete = true
		evidence.OutputBasis += "_partial"
	}
	if observation.API == core.UpstreamAPIGoogleGenerateContent && observation.Usage.OutputTokens.Presence == translate.CountPresent && observation.Usage.OutputTokens.Provenance == translate.UsageDerived && observation.Usage.ReasoningTokens.Presence == translate.CountAbsent {
		evidence.OutputIncomplete, evidence.OutputBasis = true, "derived_incomplete"
	}
	if observation.Usage.InputTokens.Presence == translate.CountAbsent && observation.Usage.BaseInputTokens.Presence == translate.CountPresent {
		input, _, invalidInput = sourceCount(observation.Usage.BaseInputTokens, 0, "unavailable")
		for _, category := range []translate.CountObservation{observation.Usage.CacheReadTokens, observation.Usage.CacheWriteTokens} {
			count, _, invalid := sourceCount(category, 0, "unavailable")
			if invalid || count > math.MaxInt-input {
				invalidInput = true
				break
			}
			input += count
		}
		evidence.InputBasis, evidence.InputIncomplete = "derived_incomplete", true
	}
	evidence.Invalid = invalidInput || invalidOutput || len(observation.Usage.Issues) > 0 || int64(input) > math.MaxInt64-int64(output)
	for _, count := range sourceCounts(observation) {
		if count.Presence == translate.CountInvalid {
			evidence.Invalid = true
		}
	}
	if evidence.Invalid {
		input, output = 0, 0
	}
	var target *router.Target
	if observation.Instance != "" && observation.Model != "" {
		target = &router.Target{Provider: observation.Instance, Model: observation.Model}
	}
	return input, output, evidence, target
}

func recordPreparedUsage(principal *config.Principal, input preparedInput, prepared *router.PreparedRequest, served *router.Target, response map[string]any, status int, errorCode string) {
	if principal == nil {
		return
	}
	in, out, evidence, observedTarget := sourceUsageSnapshot(prepared, 0, 0, "unavailable", "unavailable")
	if evidence == nil {
		if status >= http.StatusBadRequest {
			recordFailureUsage(input.endpoint, input.model, principal, status, errorCode, input.started)
		} else if input.surface == core.ModelSurfaceResponses && input.endpoint == "openai.responses" {
			recordFromResponses(input.model, served, principal, response, time.Since(input.started).Milliseconds())
		} else {
			recordFromResponse(input.endpoint, input.model, served, principal, response, time.Since(input.started).Milliseconds())
		}
		return
	}
	if observedTarget != nil {
		served = observedTarget
	}
	if evidence.SelectionUnavailable && status < http.StatusBadRequest {
		in, out = responseUsage(response)
		evidence.InputBasis, evidence.OutputBasis = "legacy_unverified", "legacy_unverified"
	}
	record := router.UsageRecord{
		RequestID: principal.RequestID, Endpoint: input.endpoint, RequestedModel: input.model,
		Project: principal.Project, Key: principal.Key, ProjectID: principal.ProjectID, PrincipalID: principal.PrincipalID, KeyID: principal.KeyID,
		InputTokens: in, OutputTokens: out, StatusCode: status, ErrorCode: errorCode,
		LatencyMS: time.Since(input.started).Milliseconds(), SourceUsage: evidence,
	}
	if served != nil {
		record.Provider, record.RoutedModel, record.IsStub = served.Provider, served.Model, isStub(served.Provider)
	}
	recordUsage(record)
}
