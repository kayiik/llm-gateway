package providers

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/config"
)

func preparedNonHealth(err error) bool {
	if err == nil {
		return false
	}
	if isContextError(err) {
		return true
	}
	if isTargetLimitError(err) {
		return true
	}
	var wrapped *preparedError
	if errors.As(err, &wrapped) {
		if wrapped.fidelity {
			return true
		}
		err = wrapped.cause
	}
	if errors.Is(err, core.ErrPreparedCallStale) || errors.Is(err, core.ErrPreparedCallConsumed) || errors.Is(err, core.ErrPreparedCallMode) {
		return true
	}
	var plan *core.CallPlanError
	var loss *core.LossPolicyError
	var configError *ConfigError
	if errors.As(err, &plan) || errors.As(err, &loss) || errors.As(err, &configError) {
		return true
	}
	var provider *core.ProviderError
	return errors.As(err, &provider) && provider.Classification.StatusCode == 0 && (provider.Class == core.ProviderErrorConfiguration || provider.Class == core.ProviderErrorInvalidRequest || provider.Class == core.ProviderErrorUnsupported)
}

func (rt *Runtime) guardPreparedCall(_ context.Context, settings *config.Settings, instance string, caller core.Caller, request core.Request, call core.PreparedCall) core.PreparedCall {
	if provider := settings.Providers[instance]; provider != nil {
		call = limitedPreparedCall(call, instance, request.Model, provider.UsageLimits)
	}
	policy := policyFor(settings, instance)
	scope := providerCacheKey(instance, caller)
	hints := &ResilientProvider{name: instance, scope: scope, policy: policy}
	attempts := max1(policy.RetryMaxAttempts)
	if request.Surface == core.ModelSurfaceResponses {
		var payload map[string]any
		if json.Unmarshal(request.Body, &payload) == nil && ResponsesPayloadIsStateful(payload) {
			attempts = 1
		}
	}
	available := func() error {
		if policy.CircuitEnabled() {
			if ok, until := rt.circuits.available(instance, scope, policy); !ok {
				return &InvocationError{Msg: instance + ": circuit breaker open for another " + formatSeconds(time.Until(until).Seconds()), Status: 503, FailoverEligible: true}
			}
		}
		return nil
	}
	record := func(err error) {
		if policy.CircuitEnabled() && !preparedNonHealth(err) {
			rt.circuits.record(instance, scope, policy, err)
		}
	}
	repeat := func(ctx context.Context, err error, attempt int) error {
		mapped := preparedFailure(err, true)
		if preparedNonHealth(err) || IsPreparedFidelityFailure(mapped) || !IsInvocation(mapped) || !InvocationRetryable(mapped) || attempt >= attempts {
			record(mapped)
			return err
		}
		delay, ok := hints.retryDelay(mapped, attempt)
		if deadline, bounded := ctx.Value(retryDeadlineKey{}).(time.Time); bounded && !time.Now().Add(delay).Before(deadline) {
			ok = false
		}
		if !ok {
			record(mapped)
			return err
		}
		return waitForRetry(ctx, delay)
	}
	return core.NewPreparedCall(call.Description(), func(ctx context.Context, c *core.Credential) (core.Response, error) {
		if err := available(); err != nil {
			return core.Response{}, err
		}
		for attempt := 1; ; attempt++ {
			response, err := call.Invoke(ctx, c)
			if ctx.Err() != nil {
				return response, ctx.Err()
			}
			if err == nil {
				record(nil)
				return response, nil
			}
			if end := repeat(ctx, err, attempt); end != nil {
				return response, end
			}
		}
	}, func(ctx context.Context, c *core.Credential) (core.StreamIter, error) {
		if err := available(); err != nil {
			return nil, err
		}
		for attempt := 1; ; attempt++ {
			stream, err := call.Stream(ctx, c)
			if ctx.Err() != nil {
				if stream != nil {
					_ = stream.Close()
				}
				return nil, ctx.Err()
			}
			if err == nil {
				record(nil)
				return stream, nil
			}
			if stream != nil {
				_ = stream.Close()
			}
			if end := repeat(ctx, err, attempt); end != nil {
				return nil, end
			}
		}
	})
}
