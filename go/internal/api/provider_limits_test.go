package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"llmgw/internal/config"
)

func TestProviderLimitsAdminRoundtripPreserveClearAndReject(t *testing.T) {
	gateway := useExtensionsAPI(t, true)
	admin := &adminCalls{t: t, server: gateway}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"data": []any{}}) }))
	defer upstream.Close()
	body := map[string]any{"id": "limited", "type": "openai_compatible", "base_url": upstream.URL, "usage_limits": map[string]any{"rpm": 2, "daily_tokens": 50, "models": map[string]any{"exact-model": map[string]any{"monthly_tokens": 100}}}}
	if status, result := admin.call(http.MethodPost, "/admin/api/providers", body); status != 200 {
		t.Fatalf("save %d %v", status, result)
	}
	limits := config.Get().Providers["limited"].UsageLimits
	if limits == nil || limits.RPM != 2 || limits.Models["exact-model"].MonthlyTokens != 100 {
		t.Fatalf("limits not persisted: %+v", limits)
	}
	delete(body, "usage_limits")
	if status, result := admin.call(http.MethodPost, "/admin/api/providers", body); status != 200 {
		t.Fatalf("edit %d %v", status, result)
	}
	if config.Get().Providers["limited"].UsageLimits.RPM != 2 {
		t.Fatal("ordinary provider edit removed limits")
	}
	body["usage_limits"] = map[string]any{"rpm": -1}
	if status, _ := admin.call(http.MethodPost, "/admin/api/providers", body); status != 400 {
		t.Fatalf("negative limits status %d", status)
	}
	if config.Get().Providers["limited"].UsageLimits.RPM != 2 {
		t.Fatal("rejected edit changed published limits")
	}
	body["usage_limits"] = map[string]any{}
	if status, result := admin.call(http.MethodPost, "/admin/api/providers", body); status != 200 {
		t.Fatalf("clear %d %v", status, result)
	}
	if config.Get().Providers["limited"].UsageLimits.Enabled() || len(config.Get().Providers["limited"].UsageLimits.Models) != 0 {
		t.Fatal("empty limits did not clear thresholds")
	}
}

func TestProviderLimitsOnlyEditPreservesProviderBinding(t *testing.T) {
	gateway := useExtensionsAPI(t, true)
	admin := &adminCalls{t: t, server: gateway}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"data": []any{}}) }))
	defer upstream.Close()
	if status, result := admin.call(http.MethodPost, "/admin/api/providers", map[string]any{"id": "limits-edit", "type": "openai_compatible", "base_url": upstream.URL}); status != 200 {
		t.Fatalf("create %d %v", status, result)
	}
	path := "/admin/api/providers/limits-edit/usage-limits"
	if status, result := admin.call(http.MethodPatch, path, map[string]any{"usage_limits": map[string]any{"rpm": 3, "models": map[string]any{"exact-model": map[string]any{"daily_tokens": 90}}}}); status != 200 {
		t.Fatalf("limits %d %v", status, result)
	}
	provider := config.Get().Providers["limits-edit"]
	if provider.BaseURL != upstream.URL || provider.Type != "openai_compatible" || provider.UsageLimits.RPM != 3 || provider.UsageLimits.Models["exact-model"].DailyTokens != 90 {
		t.Fatalf("binding changed or limits lost: %+v", provider)
	}
	for _, body := range []map[string]any{{}, {"usage_limits": nil}, {"usage_limits": map[string]any{"rpm": -1}}} {
		if status, _ := admin.call(http.MethodPatch, path, body); status != 400 {
			t.Fatalf("invalid limits status %d", status)
		}
	}
	if config.Get().Providers["limits-edit"].UsageLimits.RPM != 3 {
		t.Fatal("rejected limits replaced saved value")
	}
	if status, result := admin.call(http.MethodPatch, path, map[string]any{"usage_limits": map[string]any{}}); status != 200 {
		t.Fatalf("clear %d %v", status, result)
	}
	if config.Get().Providers["limits-edit"].UsageLimits.Enabled() {
		t.Fatal("empty limits did not clear thresholds")
	}
}
