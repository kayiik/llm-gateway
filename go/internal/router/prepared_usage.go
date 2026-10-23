package router

import (
	"slices"
	"sync"

	core "github.com/kayiik/llmgw-core"
	"llmgw/internal/providers"
)

type preparedUsageState struct {
	mu    sync.Mutex
	calls []*providers.PreparedCall
}

func (s *preparedUsageState) attempt(call *providers.PreparedCall) {
	s.mu.Lock()
	s.calls = append(s.calls, call)
	s.mu.Unlock()
}
func (s *preparedUsageState) SourceUsage() (core.SourceUsageObservation, bool) {
	if s == nil {
		return core.SourceUsageObservation{}, false
	}
	s.mu.Lock()
	if len(s.calls) == 0 {
		s.mu.Unlock()
		return core.SourceUsageObservation{}, false
	}
	last := s.calls[len(s.calls)-1]
	s.mu.Unlock()
	return core.SourceUsageOf(last)
}
func (s *preparedUsageState) SourceUsageHistory() core.SourceUsageHistory {
	if s == nil {
		return core.SourceUsageHistory{}
	}
	s.mu.Lock()
	calls := slices.Clone(s.calls)
	s.mu.Unlock()
	history := core.SourceUsageHistory{}
	for _, call := range calls {
		source := core.SourceUsageHistoryOf(call)
		history.Truncated = history.Truncated || source.Truncated
		history.Attempts = append(history.Attempts, source.Attempts...)
	}
	if len(history.Attempts) > 64 {
		history.Attempts = slices.Clone(history.Attempts[len(history.Attempts)-64:])
		history.Truncated = true
	}
	return history
}

func (p *PreparedRequest) SourceUsage() (core.SourceUsageObservation, bool) {
	if p == nil {
		return core.SourceUsageObservation{}, false
	}
	return p.usage.SourceUsage()
}
func (p *PreparedRequest) SourceUsageHistory() core.SourceUsageHistory {
	if p == nil {
		return core.SourceUsageHistory{}
	}
	return p.usage.SourceUsageHistory()
}
func (s *preparedAttemptStream) SourceUsage() (core.SourceUsageObservation, bool) {
	return s.usage.SourceUsage()
}
func (s *preparedAttemptStream) SourceUsageHistory() core.SourceUsageHistory {
	return s.usage.SourceUsageHistory()
}
