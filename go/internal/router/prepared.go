package router

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	translate "github.com/kayiik/llm-translate"
	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/config"
	"llmgw/internal/providers"
)

type PreparedOptions struct {
	Preparation core.CallPreparationOptions
	Policy      core.CallPolicy
	Generation  uint64
}

type preparedCandidate struct {
	target Target
	call   *providers.PreparedCall
}

// PreparedRequest is one request-local admission, never a reusable key grant.
// All candidates have already been authorized by the API and prepared before
// slot admission; only independently admitted candidates may be attempted.
type PreparedRequest struct {
	runtime    *Runtime
	candidates []preparedCandidate
	options    PreparedOptions
	governance *Governance
	used       *atomic.Bool
	usage      *preparedUsageState
}

func (p PreparedRequest) String() string {
	return "router.PreparedRequest{private request-local admission}"
}
func (p PreparedRequest) GoString() string { return p.String() }
func (p PreparedRequest) Format(state fmt.State, verb rune) {
	switch verb {
	case 'v', 's', 'q', 'x', 'X':
		fmt.Fprintf(state, fmt.FormatString(state, verb), p.String())
	default:
		fmt.Fprintf(state, "%%!%c(router.PreparedRequest=%s)", verb, p.String())
	}
}

func copyPreparedGovernance(ctx context.Context) *Governance {
	g := governanceFrom(ctx)
	if g == nil {
		return nil
	}
	g.AllowedRoutes = slices.Clone(g.AllowedRoutes)
	g.AllowedProviders = slices.Clone(g.AllowedProviders)
	g.AllowedModels = slices.Clone(g.AllowedModels)
	return g
}
func samePreparedGovernance(a, b *Governance) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Project == b.Project && a.Key == b.Key && a.RoutesOnly == b.RoutesOnly && slices.Equal(a.AllowedRoutes, b.AllowedRoutes) && slices.Equal(a.AllowedModels, b.AllowedModels) && slices.Equal(a.AllowedProviders, b.AllowedProviders)
}

type preparedRoutingError struct {
	message string
	status  int
	summary *AllTargetsFailed
	cause   error
}

func (e *preparedRoutingError) Error() string {
	if e.summary != nil {
		return e.summary.Error()
	}
	return providers.SanitizeDiagnosticTextLimit(e.message, 2048)
}
func (e *preparedRoutingError) Unwrap() []error {
	if e.summary != nil {
		return []error{e.cause, e.summary}
	}
	return []error{e.cause}
}
func (e *preparedRoutingError) As(target any) bool {
	if value, ok := target.(**AllTargetsFailed); ok && e.summary != nil {
		*value = e.summary
		return true
	}
	return false
}
func (e *preparedRoutingError) ProviderErrorClassification() core.ProviderErrorClassification {
	classification := core.ClassifyError(e.cause)
	classification.StatusCode = e.status
	return classification
}

func preparedRouteError(message string, status int, cause error) error {
	if cause == context.Canceled || cause == context.DeadlineExceeded {
		return cause
	}
	return &preparedRoutingError{message: message, status: status, cause: cause}
}
func preparedAllFailed(message string, status int, cause error) error {
	return &preparedRoutingError{message: message, status: status, summary: &AllTargetsFailed{Msg: message, Status: status, Err: cause}, cause: cause}
}

func preparedVision(value any) bool {
	switch node := value.(type) {
	case []any:
		for _, part := range node {
			if preparedVision(part) {
				return true
			}
		}
	case map[string]any:
		if kind, _ := node["type"].(string); kind == "image_url" || kind == "input_image" || kind == "image" {
			return true
		}
		return preparedVision(node["content"])
	}
	return false
}

func (rt *Runtime) preparedCapabilities(target Target, caller core.Caller, d core.CallDescription, payload map[string]any) bool {
	row, known := rt.providers().CatalogCachedLookupForPrincipal(target.Provider, target.Model, caller)
	if !known || row.TypedCapabilities == nil {
		return true
	}
	return preparedModelCapabilities(row.TypedCapabilities, d, payload, time.Now())
}

func preparedConstrainedFormat(value any) bool {
	format, _ := value.(map[string]any)
	kind, _ := format["type"].(string)
	return kind == "json_object" || kind == "json_schema"
}

func preparedModelCapabilities(capabilities *core.ModelCapabilities, d core.CallDescription, payload map[string]any, now time.Time) bool {
	if !core.PreparedCapabilityDenialsUsable(capabilities, now) {
		return true
	}
	if capabilities.Operations.Chat == core.SupportUnsupported || d.Requirements.Tools && capabilities.Tools == core.SupportUnsupported {
		return false
	}
	if (preparedVision(payload["messages"]) || preparedVision(payload["input"])) && capabilities.Inputs.Image == core.SupportUnsupported {
		return false
	}
	if d.Mode == core.CallModeStream && (d.UpstreamTransport == core.CallTransportSSE || d.UpstreamTransport == core.CallTransportNDJSON) && capabilities.Streaming == core.SupportUnsupported {
		return false
	}
	if preparedConstrainedFormat(payload["response_format"]) && capabilities.StructuredOutput == core.SupportUnsupported {
		return false
	}
	if text, _ := payload["text"].(map[string]any); preparedConstrainedFormat(text["format"]) && capabilities.StructuredOutput == core.SupportUnsupported {
		return false
	}
	if output, _ := payload["output_config"].(map[string]any); preparedConstrainedFormat(output["format"]) && capabilities.StructuredOutput == core.SupportUnsupported {
		return false
	}
	switch d.UpstreamAPI {
	case core.UpstreamAPIChatCompletions, core.UpstreamAPIResponses, core.UpstreamAPIMessages:
		if capabilities.SurfaceCompatibility(core.ModelSurface(d.UpstreamAPI)) == core.SupportUnsupported {
			return false
		}
	}
	if d.Ingress == core.ModelSurfaceResponses && providers.ResponsesPayloadIsStateful(payload) && capabilities.StatefulResponses == core.SupportUnsupported {
		return false
	}
	return true
}

func (rt *Runtime) PrepareRequest(ctx context.Context, targets []Target, caller core.Caller, request core.Request, options PreparedOptions) (*PreparedRequest, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if options.Generation != config.Generation() {
		return nil, preparedRouteError(core.ErrPreparedCallStale.Error(), 409, core.ErrPreparedCallStale)
	}
	if options.Preparation.AllowAdaptation != options.Policy.AllowAdaptation {
		return nil, preparedRouteError("preparation and admission compatibility permissions disagree", 400, nil)
	}
	request.Body = slices.Clone(request.Body)
	request.Header = request.Header.Clone()
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(request.Body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		return nil, preparedRouteError("prepared request must be a JSON object", 400, err)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, preparedRouteError("prepared request must contain one JSON object", 400, err)
	}
	// Opaque provider state is not portable between independently configured
	// targets. Keep the existing Responses first-target boundary and extend it
	// to the actual signed/encrypted state inferred by the finite assessment.
	if (translate.InferFidelityRequirements(payload).Replay || options.Preparation.Requirements.Replay || request.Surface == core.ModelSurfaceResponses && providers.ResponsesPayloadIsStateful(payload)) && len(targets) > 1 {
		targets = targets[:1]
	}
	prepared := &PreparedRequest{runtime: rt, options: options, governance: copyPreparedGovernance(ctx), used: &atomic.Bool{}, usage: &preparedUsageState{}}
	if prepared.options.Preparation.Mode == "" {
		prepared.options.Preparation.Mode = core.CallModeInvoke
	}
	var excluded []string
	var last error
	var operational error
	for _, target := range targets {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if config.Generation() != options.Generation {
			return nil, preparedRouteError(core.ErrPreparedCallStale.Error(), 409, core.ErrPreparedCallStale)
		}
		selected := request
		selected.Model = target.Model
		call, err := rt.providers().PrepareCall(ctx, target.Provider, caller, selected, prepared.options.Preparation)
		if err == nil {
			_, err = core.PlanPreparedCall(call.Description(), prepared.options.Policy)
		}
		if err == nil && !rt.preparedCapabilities(target, caller, call.Description(), payload) {
			err = &providers.InvocationError{Msg: "cached model evidence explicitly excludes a required operation or feature", Status: 400}
		}
		if config.Generation() != options.Generation || errors.Is(err, core.ErrPreparedCallStale) {
			return nil, preparedRouteError(core.ErrPreparedCallStale.Error(), 409, core.ErrPreparedCallStale)
		}
		if err != nil {
			last = err
			if providers.IsConfig(err) || providers.UpstreamStatus(err) >= 500 {
				operational = err
			}
			if len(excluded) < 8 {
				excluded = append(excluded, target.Provider+"/"+target.Model+": "+providers.SanitizeDiagnosticTextLimit(err.Error(), 200))
			}
			continue
		}
		prepared.candidates = append(prepared.candidates, preparedCandidate{target: target, call: call})
	}
	if config.Generation() != options.Generation {
		return nil, preparedRouteError(core.ErrPreparedCallStale.Error(), 409, core.ErrPreparedCallStale)
	}
	if len(prepared.candidates) == 0 {
		if operational != nil {
			return nil, preparedAllFailed("provider configuration/preparation failed; "+strings.Join(excluded, "; "), 500, operational)
		}
		return nil, preparedAllFailed("no eligible prepared targets; "+strings.Join(excluded, "; "), 400, last)
	}
	return prepared, nil
}

func (p *PreparedRequest) Targets() []Target {
	if p == nil {
		return nil
	}
	targets := make([]Target, len(p.candidates))
	for i, candidate := range p.candidates {
		targets[i] = candidate.target
	}
	return targets
}
func (p *PreparedRequest) Descriptions() []core.CallDescription {
	if p == nil {
		return nil
	}
	descriptions := make([]core.CallDescription, len(p.candidates))
	for i, candidate := range p.candidates {
		descriptions[i] = candidate.call.Description()
	}
	return descriptions
}

func (p *PreparedRequest) check(ctx context.Context, mode core.CallMode) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if p == nil || p.options.Generation != config.Generation() || !samePreparedGovernance(p.governance, governanceFrom(ctx)) {
		return preparedRouteError(core.ErrPreparedCallStale.Error(), 409, core.ErrPreparedCallStale)
	}
	if p.options.Preparation.Mode != mode {
		return preparedRouteError(core.ErrPreparedCallMode.Error(), 409, core.ErrPreparedCallMode)
	}
	return nil
}

func (p *PreparedRequest) ordered(ctx context.Context) (context.Context, context.CancelFunc, []Target, map[Target][]*providers.PreparedCall) {
	budget, cancel, targets := prepareFallback(ctx, p.Targets(), nil)
	queues := map[Target][]*providers.PreparedCall{}
	for _, candidate := range p.candidates {
		queues[candidate.target] = append(queues[candidate.target], candidate.call)
	}
	return budget, cancel, targets, queues
}

func (p *PreparedRequest) Invoke(ctx context.Context, requested string) (core.Response, *Target, []AttemptTrace, error) {
	if err := p.check(ctx, core.CallModeInvoke); err != nil {
		return core.Response{}, nil, nil, err
	}
	if !p.used.CompareAndSwap(false, true) {
		return core.Response{}, nil, nil, preparedRouteError(core.ErrPreparedCallConsumed.Error(), 409, core.ErrPreparedCallConsumed)
	}
	budget, cancel, targets, queues := p.ordered(ctx)
	defer cancel()
	var attempts []attempt
	var traces []AttemptTrace
	var last error
	var retained core.Response
	var losses []core.Loss
	result, served := walk(budget, targets, func(target Target) (core.Response, error) {
		if err := p.check(ctx, core.CallModeInvoke); err != nil {
			last = err
			return core.Response{}, stop(err)
		}
		if budget.Err() != nil {
			last = budget.Err()
			return core.Response{}, stop(last)
		}
		call := queues[target][0]
		queues[target] = queues[target][1:]
		p.usage.attempt(call)
		start := time.Now()
		response, err := call.Invoke(attemptContext(ctx, budget), p.options.Policy)
		losses = translate.NewReport(slices.Concat(losses, response.Losses)...).Losses
		response.Losses = slices.Clone(losses)
		retained = response
		trace := AttemptTrace{Provider: target.Provider, Model: target.Model, DurationMS: time.Since(start).Milliseconds(), Status: "served"}
		if err != nil {
			trace.Status = "failed"
			trace.Throttled = providers.IsThrottle(err)
		}
		traces = append(traces, trace)
		attempts = append(attempts, attempt{Provider: target.Provider, Model: target.Model, OK: err == nil, Error: preparedAttemptError(err), Throttled: providers.IsThrottle(err)})
		if err != nil {
			last = err
			return response, judge(err, !providers.IsPreparedFidelityFailure(err) && !errors.Is(err, core.ErrPreparedCallStale) && shouldAdvance(err))
		}
		return response, nil
	})
	p.runtime.recordChain(ctx, requested, attempts, served)
	keepPreparedTrace(ctx, traces)
	if served != nil {
		return result, served, traces, nil
	}
	if errors.Is(last, context.Canceled) {
		return retained, nil, traces, context.Canceled
	}
	status := deadlineStatus(last)
	if status == 0 {
		status = 502
	}
	message := "no prepared target completed"
	if last != nil {
		message = last.Error()
	}
	return retained, nil, traces, preparedAllFailed(message, status, last)
}

func preparedAttemptError(err error) string {
	if err == nil {
		return ""
	}
	return truncate(err.Error())
}

type preparedAttemptStream struct {
	core.StreamIter
	release func()
	usage   *preparedUsageState
}

func (s *preparedAttemptStream) Close() error        { err := s.StreamIter.Close(); s.release(); return err }
func (s *preparedAttemptStream) Losses() []core.Loss { return core.StreamLosses(s.StreamIter) }

func (p *PreparedRequest) Stream(ctx context.Context, requested string) (core.StreamIter, *Target, []AttemptTrace, error) {
	if err := p.check(ctx, core.CallModeStream); err != nil {
		return nil, nil, nil, err
	}
	if !p.used.CompareAndSwap(false, true) {
		return nil, nil, nil, preparedRouteError(core.ErrPreparedCallConsumed.Error(), 409, core.ErrPreparedCallConsumed)
	}
	budget, cancel, targets, queues := p.ordered(ctx)
	defer cancel()
	var attempts []attempt
	var traces []AttemptTrace
	var last error
	result, served := walk(budget, targets, func(target Target) (core.StreamIter, error) {
		if err := p.check(ctx, core.CallModeStream); err != nil {
			last = err
			return nil, stop(err)
		}
		if budget.Err() != nil {
			last = budget.Err()
			return nil, stop(last)
		}
		call := queues[target][0]
		queues[target] = queues[target][1:]
		p.usage.attempt(call)
		attemptCtx, opened, release := streamAttempt(ctx, budget)
		start := time.Now()
		stream, err := call.Stream(attemptCtx, p.options.Policy)
		if budget.Err() != nil {
			if stream != nil {
				_ = stream.Close()
			}
			release()
			last = budget.Err()
			return nil, stop(last)
		}
		trace := AttemptTrace{Provider: target.Provider, Model: target.Model, DurationMS: time.Since(start).Milliseconds(), Status: "served"}
		if err != nil {
			trace.Status = "failed"
			trace.Throttled = providers.IsThrottle(err)
		}
		traces = append(traces, trace)
		attempts = append(attempts, attempt{Provider: target.Provider, Model: target.Model, OK: err == nil, Error: preparedAttemptError(err), Throttled: providers.IsThrottle(err)})
		if err != nil {
			if stream != nil {
				_ = stream.Close()
			}
			release()
			last = err
			return nil, judge(err, !providers.IsPreparedFidelityFailure(err) && !errors.Is(err, core.ErrPreparedCallStale) && shouldAdvance(err))
		}
		if !opened() {
			if stream != nil {
				_ = stream.Close()
			}
			release()
			last = budget.Err()
			if last == nil {
				last = context.DeadlineExceeded
			}
			return nil, stop(last)
		}
		return &preparedAttemptStream{StreamIter: stream, release: release, usage: p.usage}, nil
	})
	p.runtime.recordChain(ctx, requested, attempts, served)
	keepPreparedTrace(ctx, traces)
	if served != nil {
		return result, served, traces, nil
	}
	if errors.Is(last, context.Canceled) {
		return nil, nil, traces, context.Canceled
	}
	status := deadlineStatus(last)
	if status == 0 {
		status = 502
	}
	message := "no prepared target opened"
	if last != nil {
		message = last.Error()
	}
	return nil, nil, traces, preparedAllFailed(message, status, last)
}

func keepPreparedTrace(ctx context.Context, traces []AttemptTrace) {
	if sink := traceSinkFrom(ctx); sink != nil {
		sink.mu.Lock()
		sink.attempts = slices.Clone(traces)
		sink.mu.Unlock()
	}
}
