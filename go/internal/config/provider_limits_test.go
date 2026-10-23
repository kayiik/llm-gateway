package config

import (
	"encoding/json"
	"testing"
)

func TestProviderUsageLimitsValidationAndSnapshotIsolation(t *testing.T) {
	for _, raw := range []string{`{"rpm":1,"daily_tokens":20,"models":{"m":{"rpm":2}}}`, `{}`} {
		var value any
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			t.Fatal(err)
		}
		limits, err := parseProviderUsageLimits(value)
		if err != nil {
			t.Fatal(err)
		}
		provider := &ProviderConfig{Type: "openai_compatible", UsageLimits: limits}
		cloned := cloneProvider(provider)
		cloned.UsageLimits.RPM = 99
		if cloned.UsageLimits.Models != nil {
			cloned.UsageLimits.Models["m"] = TargetUsageLimits{RPM: 99}
		}
		if provider.UsageLimits.RPM == 99 || provider.UsageLimits.Models["m"].RPM == 99 {
			t.Fatal("mutable limits escaped snapshot clone")
		}
	}
	for _, raw := range []string{`{"rpm":-1}`, `{"rpm":1.5}`, `{"rpm":"1"}`, `{"mystery":1}`, `{"models":{"":{"rpm":1}}}`, `{"models":{" m ":{"rpm":1}}}`, `{"models":{"m":{"monthly_tokens":-1}}}`} {
		var value any
		_ = json.Unmarshal([]byte(raw), &value)
		if _, err := parseProviderUsageLimits(value); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
