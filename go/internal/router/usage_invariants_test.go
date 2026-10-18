package router

import (
	"math"
	"testing"

	"llmgw/internal/config"
	"llmgw/internal/iam"
)

func TestRecordUsageRejectsInvalidMeteringAndPrices(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	iam.ResetForTests()
	ResetSavingsState()
	old := *config.Get()
	t.Cleanup(func() {
		iam.ResetForTests()
		ResetSavingsState()
		config.Update(func(s *config.Settings) { *s = old })
	})
	db, err := iam.DB()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		edit func(*UsageRecord)
		rate float64
	}{
		{"input", func(r *UsageRecord) { r.InputTokens = -1 }, 1},
		{"output", func(r *UsageRecord) { r.OutputTokens = -1 }, 1},
		{"credits", func(r *UsageRecord) { r.CreditsMilli = -1 }, 1},
		{"latency", func(r *UsageRecord) { r.LatencyMS = -1 }, 1},
		{"negative price", func(*UsageRecord) {}, -1},
		{"nan price", func(*UsageRecord) {}, math.NaN()},
		{"infinite price", func(*UsageRecord) {}, math.Inf(1)},
		{"unrepresentable cost", func(*UsageRecord) {}, math.MaxFloat64},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config.Update(func(s *config.Settings) {
				s.Savings.Enabled = true
				s.Savings.PriceCatalog = map[string]map[string]float64{"fixture": {"input": tc.rate, "output": 1}}
			})
			record := UsageRecord{RoutedModel: "fixture", InputTokens: 1, OutputTokens: 1}
			tc.edit(&record)
			RecordUsage(record)
			var count int
			if err := db.QueryRow(`SELECT COUNT(*) FROM usage_events`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatalf("invalid usage entered IAM: %d rows", count)
			}
			if totals := Totals(true); totals["requests"] != int64(0) {
				t.Fatalf("invalid usage entered savings: %v", totals)
			}
		})
	}
}
