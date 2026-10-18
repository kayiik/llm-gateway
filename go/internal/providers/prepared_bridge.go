package providers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"

	core "github.com/kayiik/llmgw-core"
	coreruntime "github.com/kayiik/llmgw-core/runtime"
	coretranslation "github.com/kayiik/llmgw-core/translation"
	"llmgw/internal/config"
)

// PreparedCall is request-local. Its captured Caller is not a per-key grant;
// the router/API must retain governance and never cache or expose this handle.
type PreparedCall struct {
	runtime            *Runtime
	instance, vertical string
	caller             core.Caller
	request            core.Request
	handle             *coreruntime.PreparedCall
	options            core.CallPreparationOptions
	generation         uint64
}

func preparedRequestCopy(request core.Request) core.Request {
	request.Body = slices.Clone(request.Body)
	request.Header = request.Header.Clone()
	request.Credential = nil
	return request
}

func (p *PreparedCall) Description() core.CallDescription {
	if p == nil || p.handle == nil {
		return core.CallDescription{}
	}
	return p.handle.Description()
}
func (PreparedCall) String() string     { return "providers.PreparedCall{private binding}" }
func (p PreparedCall) GoString() string { return p.String() }
func (p PreparedCall) Format(state fmt.State, verb rune) {
	switch verb {
	case 'v', 's', 'q', 'x', 'X':
		fmt.Fprintf(state, fmt.FormatString(state, verb), p.String())
	default:
		fmt.Fprintf(state, "%%!%c(providers.PreparedCall=%s)", verb, p.String())
	}
}

func (rt *Runtime) PrepareCall(ctx context.Context, instance string, caller core.Caller, request core.Request, options core.CallPreparationOptions) (*PreparedCall, error) {
	settings, generation := rt.settings.Snapshot()
	name, _, ok := rt.vertical(settings, instance)
	if !ok {
		return nil, preparedFailure(errNotServedByCore(instance), false)
	}
	if settings.Providers[instance].Disabled {
		return nil, preparedFailure(core.ErrPreparedCallStale, false)
	}
	request = preparedRequestCopy(request)
	ctx = withCoreOperation(ctx, name, caller)
	handle, err := rt.core.PrepareCall(ctx, caller, instance, request, options)
	_, current := rt.settings.Snapshot()
	if current != generation {
		return nil, preparedFailure(core.ErrPreparedCallStale, false)
	}
	if err != nil {
		return nil, preparedFailure(err, false)
	}
	return &PreparedCall{runtime: rt, instance: instance, vertical: name, caller: caller, request: request, handle: handle, options: options, generation: generation}, nil
}

func (p *PreparedCall) check(policy core.CallPolicy) error {
	if p == nil || p.handle == nil {
		return preparedFailure(core.ErrPreparedCallStale, false)
	}
	_, generation := p.runtime.settings.Snapshot()
	if generation != p.generation {
		return preparedFailure(core.ErrPreparedCallStale, false)
	}
	if policy.AllowAdaptation && !p.options.AllowAdaptation {
		return preparedFailure(&core.CallPlanError{Reason: "execution cannot broaden preparation compatibility permission"}, false)
	}
	_, err := core.PlanPreparedCall(p.Description(), policy)
	return preparedFailure(err, false)
}

// The private SDK handle is never a ticket a caller can alter to change its
// runtime, identity or request bytes.
func (p *PreparedCall) Invoke(ctx context.Context, policy core.CallPolicy) (core.Response, error) {
	if err := p.check(policy); err != nil {
		return core.Response{}, err
	}
	ctx = withCoreOperation(ctx, p.vertical, p.caller)
	response, err := p.runtime.core.InvokePrepared(ctx, p.caller, p.instance, p.request, p.handle, policy)
	return response, preparedFailure(err, true)
}

func (p *PreparedCall) Stream(ctx context.Context, policy core.CallPolicy) (core.StreamIter, error) {
	if err := p.check(policy); err != nil {
		return nil, err
	}
	ctx = withCoreOperation(ctx, p.vertical, p.caller)
	stream, err := p.runtime.core.StreamPrepared(ctx, p.caller, p.instance, p.request, p.handle, policy)
	if err != nil {
		return nil, preparedFailure(err, true)
	}
	return &preparedErrorStream{StreamIter: stream}, nil
}

type preparedCoreProvider struct {
	core.Provider
	runtime  *Runtime
	settings *config.Settings
	instance string
}

func (p *preparedCoreProvider) Unwrap() core.Provider { return p.Provider }
func (p *preparedCoreProvider) PreservesWire(model string, surface core.ModelSurface) bool {
	return core.PreservesWire(p.Provider, model, surface)
}
func (p *preparedCoreProvider) PreservesWireFor(c *core.Credential, model string, surface core.ModelSurface) bool {
	return core.PreservesWireFor(p.Provider, c, model, surface)
}

func (p *preparedCoreProvider) PrepareCall(ctx context.Context, request core.Request, options core.CallPreparationOptions) (core.PreparedCall, error) {
	provider := p.Provider
	// OpenAI caller-scoped model evidence must be bound BEFORE route choice.
	if binding, ok := provider.(interface {
		preparedProviderBinding(context.Context) (core.Provider, error)
	}); ok {
		var err error
		provider, err = binding.preparedProviderBinding(ctx)
		if err != nil {
			return nil, err
		}
	}
	call, err := core.PrepareCall(ctx, coretranslation.Adapter{Provider: provider}, request, options)
	if err != nil {
		return nil, err
	}
	caller := coreOperationFrom(ctx).caller
	return p.runtime.guardPreparedCall(ctx, p.settings, p.instance, caller, request, call), nil
}

type preparedCountingCoreProvider struct{ *preparedCoreProvider }

func (p *preparedCountingCoreProvider) CountTokens(ctx context.Context, request core.TokenCountRequest) (core.TokenCount, error) {
	return core.CountTokens(ctx, p.Provider, request)
}

func (rt *Runtime) preparationProvider(settings *config.Settings, instance string, provider core.Provider) core.Provider {
	wrapper := &preparedCoreProvider{Provider: provider, runtime: rt, settings: settings, instance: instance}
	if _, ok := provider.(core.TokenCounter); ok {
		return &preparedCountingCoreProvider{wrapper}
	}
	return wrapper
}

type preparedError struct {
	*InvocationError
	cause    error
	fidelity bool
}

// Configuration is an operational failure, not an incompatibility and not an
// upstream transient. Avoid an InvocationError status500 shadow which would
// manufacture retries/circuit penalties under the legacy status predicates.
type preparedConfigurationError struct{ cause error }

func (e *preparedConfigurationError) Error() string {
	return SanitizeDiagnosticTextLimit(e.cause.Error(), diagnosticErrorLimit)
}
func (e *preparedConfigurationError) Unwrap() error { return e.cause }
func (e *preparedConfigurationError) ProviderErrorClassification() core.ProviderErrorClassification {
	return core.ProviderErrorClassification{StatusCode: 500}
}

func (e *preparedError) Unwrap() []error { return []error{e.InvocationError, e.cause} }

// IsPreparedFidelityFailure distinguishes execution-time conversion refusal
// from a target's transient unavailability: a new paid repair is not failover.
func IsPreparedFidelityFailure(err error) bool {
	var failure *preparedError
	if errors.As(err, &failure) && failure.fidelity {
		return true
	}
	return false
}

func preparedFailure(err error, execution bool) error {
	if err == nil {
		return nil
	}
	if isContextError(err) {
		return err
	}
	var existing *preparedError
	if errors.As(err, &existing) {
		return err
	}
	var configuration *preparedConfigurationError
	if errors.As(err, &configuration) {
		return err
	}
	var localConfig *ConfigError
	var coreConfig *core.ProviderError
	if errors.As(err, &localConfig) || (errors.As(err, &coreConfig) && coreConfig.Class == core.ProviderErrorConfiguration) {
		return &preparedConfigurationError{cause: err}
	}
	classification := core.ClassifyError(err)
	invocation := &InvocationError{Msg: SanitizeDiagnosticTextLimit(err.Error(), diagnosticErrorLimit), Status: classification.StatusCode, Retryable: classification.Retryable,
		FailoverEligible: classification.FailoverEligible, CircuitFailure: classification.CircuitFailure, RetryAfter: retryAfterSeconds(classification.RetryAfter), Reason: coreRefusalReason(err)}
	var plan *core.CallPlanError
	var loss *core.LossPolicyError
	var surface *core.SurfaceError
	var configError *ConfigError
	var providerError *core.ProviderError
	fidelity := errors.As(err, &plan) || errors.As(err, &loss)
	switch {
	case errors.Is(err, core.ErrPreparedCallStale) || errors.Is(err, core.ErrPreparedCallConsumed) || errors.Is(err, core.ErrPreparedCallMode):
		invocation.Status = 409
		invocation.Retryable = false
		invocation.FailoverEligible = false
		invocation.CircuitFailure = false
	case fidelity:
		invocation.Status = 400
		invocation.Retryable = false
		invocation.FailoverEligible = !execution
		invocation.CircuitFailure = false
	case errors.As(err, &surface):
		if invocation.Status == 0 {
			invocation.Status = 400
		}
		invocation.Retryable = false
		invocation.FailoverEligible = true
		invocation.CircuitFailure = false
	case errors.As(err, &configError):
		return &preparedConfigurationError{cause: err}
	case errors.As(err, &providerError):
		if invocation.Status == 0 && (providerError.Class == core.ProviderErrorConfiguration || providerError.Class == core.ProviderErrorInvalidRequest || providerError.Class == core.ProviderErrorUnsupported) {
			invocation.Status = 400
			invocation.Retryable = false
			invocation.FailoverEligible = true
			invocation.CircuitFailure = false
		}
	}
	return &preparedError{InvocationError: invocation, cause: err, fidelity: fidelity && execution}
}

type preparedErrorStream struct{ core.StreamIter }

func (s *preparedErrorStream) Next() ([]byte, error) {
	frame, err := s.StreamIter.Next()
	if err == io.EOF {
		return frame, io.EOF
	}
	return frame, preparedFailure(err, true)
}
func (s *preparedErrorStream) Losses() []core.Loss { return core.StreamLosses(s.StreamIter) }
