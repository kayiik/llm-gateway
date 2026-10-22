package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"strings"
)

// TargetUsageLimits count dispatch admissions and observed tokens in UTC windows.
// Zero leaves that threshold unlimited; tokens are settled, never reserved.
type TargetUsageLimits struct {
	RPM           int64 `yaml:"rpm,omitempty" json:"rpm,omitempty"`
	DailyTokens   int64 `yaml:"daily_tokens,omitempty" json:"daily_tokens,omitempty"`
	MonthlyTokens int64 `yaml:"monthly_tokens,omitempty" json:"monthly_tokens,omitempty"`
}

type ProviderUsageLimits struct {
	TargetUsageLimits `yaml:",inline"`
	Models            map[string]TargetUsageLimits `yaml:"models,omitempty" json:"models,omitempty"`
}

func (l TargetUsageLimits) Enabled() bool {
	return l.RPM > 0 || l.DailyTokens > 0 || l.MonthlyTokens > 0
}

func (l *ProviderUsageLimits) Validate() error {
	if l == nil {
		return nil
	}
	valid := func(v TargetUsageLimits) bool { return v.RPM >= 0 && v.DailyTokens >= 0 && v.MonthlyTokens >= 0 }
	if !valid(l.TargetUsageLimits) {
		return fmt.Errorf("usage_limits thresholds must be non-negative integers")
	}
	for model, limit := range l.Models {
		if strings.TrimSpace(model) == "" || model != strings.TrimSpace(model) || !valid(limit) {
			return fmt.Errorf("usage_limits models must name exact non-empty model IDs with non-negative integer thresholds")
		}
	}
	return nil
}

func parseProviderUsageLimits(raw any) (*ProviderUsageLimits, error) {
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid usage_limits")
	}
	var limits ProviderUsageLimits
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&limits); err != nil {
		return nil, fmt.Errorf("usage_limits must contain integer rpm/daily_tokens/monthly_tokens and optional models")
	}
	return &limits, limits.Validate()
}

func cloneProviderUsageLimits(limits *ProviderUsageLimits) *ProviderUsageLimits {
	if limits == nil {
		return nil
	}
	copy := *limits
	copy.Models = maps.Clone(limits.Models)
	return &copy
}
