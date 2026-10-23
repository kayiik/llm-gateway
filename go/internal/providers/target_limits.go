package providers

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"

	translate "github.com/kayiik/llm-translate"
	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/config"
	"llmgw/internal/iam"
)

// Local capacity refusals advance the route, but neither retry nor penalize
// provider health. Storage/settlement errors stop rather than replay inference.
type targetLimitError struct{ *InvocationError }

func (e *targetLimitError) ProviderErrorClassification() core.ProviderErrorClassification {
	return core.ProviderErrorClassification{Local: true, StatusCode: e.Status, FailoverEligible: e.FailoverEligible, RetryAfter: retryAfterDelay(e.RetryAfter, time.Now())}
}
func (e *targetLimitError) As(target any) bool {
	if invocation, ok := target.(**InvocationError); ok {
		*invocation = e.InvocationError
		return true
	}
	return asProviderError(target, e)
}

func targetCapacityError(err error) error {
	var exceeded *iam.QuotaExceeded
	if errors.As(err, &exceeded) {
		return &targetLimitError{&InvocationError{Msg: exceeded.Error(), Status: 429, FailoverEligible: true, RetryAfter: retryAfterSeconds(max(time.Second, time.Until(exceeded.Reset)))}}
	}
	if isContextError(err) {
		return err
	}
	return &targetLimitError{&InvocationError{Msg: "target usage counter store unavailable", Status: 500}}
}

func isTargetLimitError(err error) bool {
	var limit *targetLimitError
	return errors.As(err, &limit)
}

func targetObservedTokens(o core.SourceUsageObservation) (int64, bool) {
	u, d := o.Usage, o.Details
	if len(u.Issues) > 0 {
		return 0, false
	}
	for _, count := range []translate.CountObservation{u.InputTokens, u.OutputTokens, u.TotalTokens, u.BaseInputTokens, u.CacheReadTokens, u.CacheWriteTokens, u.ReasoningTokens, u.CacheWrite5mTokens, u.CacheWrite1hTokens, d.InputAudioTokens, d.OutputAudioTokens, d.AcceptedPredictionTokens, d.RejectedPredictionTokens, d.WebSearchRequests, d.WebFetchRequests} {
		if count.Presence == translate.CountInvalid || count.Value < 0 {
			return 0, false
		}
	}
	present := func(c translate.CountObservation) bool {
		return c.Presence == translate.CountPresent && c.Provenance != translate.UsageSynthetic
	}
	if present(u.TotalTokens) {
		return u.TotalTokens.Value, true
	}
	var total int64
	add := func(c translate.CountObservation) bool {
		if !present(c) {
			return true
		}
		if total > math.MaxInt64-c.Value {
			return false
		}
		total += c.Value
		return true
	}
	if present(u.InputTokens) {
		if !add(u.InputTokens) {
			return 0, false
		}
	} else if present(u.BaseInputTokens) {
		for _, c := range []translate.CountObservation{u.BaseInputTokens, u.CacheReadTokens, u.CacheWriteTokens} {
			if !add(c) {
				return 0, false
			}
		}
	}
	if !add(u.OutputTokens) {
		return 0, false
	}
	return total, present(u.InputTokens) || present(u.BaseInputTokens) || present(u.OutputTokens)
}

func limitedPreparedCall(call core.PreparedCall, instance, model string, limits *config.ProviderUsageLimits) core.PreparedCall {
	if limits == nil || (!limits.Enabled() && !limits.Models[model].Enabled()) {
		return call
	}
	admit := func(ctx context.Context) (func() error, error) {
		at := time.Now()
		if err := iam.CheckAndConsumeTargetRequest(ctx, instance, model, limits, at); err != nil {
			return nil, targetCapacityError(err)
		}
		var previous uint64
		for _, o := range core.SourceUsageHistoryFromContext(ctx).Attempts {
			previous = max(previous, o.Attempt)
		}
		var once sync.Once
		var settlement error
		return func() error {
			once.Do(func() {
				var tokens int64
				for _, o := range core.SourceUsageHistoryFromContext(ctx).Attempts {
					if o.Attempt <= previous || o.Instance != instance || o.Model != model {
						continue
					}
					count, valid := targetObservedTokens(o)
					if !valid {
						continue
					}
					if tokens > math.MaxInt64-count {
						settlement = targetCapacityError(errors.New("token overflow"))
						return
					}
					tokens += count
				}
				if err := iam.SettleTargetTokens(instance, model, at, tokens); err != nil {
					settlement = targetCapacityError(err)
				}
			})
			return settlement
		}, nil
	}
	// NewPreparedCall executes the existing credential/generation context fence
	// before admission, including after a retry delay.
	return core.NewPreparedCall(call.Description(), func(ctx context.Context, c *core.Credential) (core.Response, error) {
		settle, err := admit(ctx)
		if err != nil {
			return core.Response{}, err
		}
		response, err := call.Invoke(ctx, c)
		if end := settle(); end != nil {
			return response, end
		}
		return response, err
	}, func(ctx context.Context, c *core.Credential) (core.StreamIter, error) {
		settle, err := admit(ctx)
		if err != nil {
			return nil, err
		}
		stream, err := call.Stream(ctx, c)
		if err != nil {
			if stream != nil {
				_ = stream.Close()
			}
			if end := settle(); end != nil {
				return nil, end
			}
			return nil, err
		}
		return &targetLimitedStream{StreamIter: stream, settle: settle}, nil
	})
}

type targetLimitedStream struct {
	core.StreamIter
	settle func() error
}

func (s *targetLimitedStream) Next() ([]byte, error) {
	frame, err := s.StreamIter.Next()
	if err != nil {
		if end := s.settle(); end != nil {
			return frame, end
		}
	}
	return frame, err
}
func (s *targetLimitedStream) Close() error {
	err := s.StreamIter.Close()
	return errors.Join(err, s.settle())
}
func (s *targetLimitedStream) Losses() []core.Loss { return core.StreamLosses(s.StreamIter) }
func (s *targetLimitedStream) SourceUsage() (core.SourceUsageObservation, bool) {
	return core.SourceUsageOf(s.StreamIter)
}
func (s *targetLimitedStream) SourceUsageHistory() core.SourceUsageHistory {
	return core.SourceUsageHistoryOf(s.StreamIter)
}
