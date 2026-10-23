package providers

import core "github.com/kayiik/llmgw-core"

func (p *PreparedCall) SourceUsage() (core.SourceUsageObservation, bool) {
	if p == nil {
		return core.SourceUsageObservation{}, false
	}
	return core.SourceUsageOf(p.handle)
}
func (p *PreparedCall) SourceUsageHistory() core.SourceUsageHistory {
	if p == nil {
		return core.SourceUsageHistory{}
	}
	return core.SourceUsageHistoryOf(p.handle)
}
func (s *preparedErrorStream) SourceUsage() (core.SourceUsageObservation, bool) {
	return core.SourceUsageOf(s.StreamIter)
}
func (s *preparedErrorStream) SourceUsageHistory() core.SourceUsageHistory {
	return core.SourceUsageHistoryOf(s.StreamIter)
}
