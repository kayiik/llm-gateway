package iam

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"time"

	"llmgw/internal/config"
)

// CheckAndConsumeTargetRequest is dispatch admission, not proof of upstream
// receipt. A rejected model scope rolls back the provider-wide slot as well.
func CheckAndConsumeTargetRequest(ctx context.Context, provider, model string, limits *config.ProviderUsageLimits, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if limits == nil || (!limits.Enabled() && !limits.Models[model].Enabled()) {
		return nil
	}
	if err := limits.Validate(); err != nil {
		return err
	}
	db, err := DB()
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	minute, day, month := quotaPeriods(now)
	periods := []struct {
		name  string
		start int64
	}{{"minute", minute}, {"day", day}, {"month", month}}
	for _, scope := range []struct {
		model  string
		limits config.TargetUsageLimits
	}{{"", limits.TargetUsageLimits}, {model, limits.Models[model]}} {
		for _, period := range periods {
			// Acquire SQLite's writer lock before reading either scope, including
			// when another gateway process shares this database.
			if _, err := tx.ExecContext(ctx, `INSERT INTO target_quota_counters(provider_id,model,period,period_start)
VALUES(?,?,?,?) ON CONFLICT DO NOTHING`, provider, scope.model, period.name, period.start); err != nil {
				return err
			}
			var requests, tokens int64
			if err := tx.QueryRowContext(ctx, `SELECT requests,observed_tokens FROM target_quota_counters
WHERE provider_id=? AND model=? AND period=? AND period_start=?`, provider, scope.model, period.name, period.start).Scan(&requests, &tokens); err != nil {
				return err
			}
			limit, used, field := scope.limits.RPM, requests, "rpm"
			if period.name == "day" {
				limit, used, field = scope.limits.DailyTokens, tokens, "daily_tokens"
			}
			if period.name == "month" {
				limit, used, field = scope.limits.MonthlyTokens, tokens, "monthly_tokens"
			}
			if limit > 0 && used >= limit {
				scopeName := "provider"
				if scope.model != "" {
					scopeName = "provider_model"
				}
				return &QuotaExceeded{Scope: scopeName, Field: field, Metric: scopeName + " " + field, Limit: limit, Reset: quotaWindowEnds(now).at(period.name)}
			}
			if requests == math.MaxInt64 {
				return fmt.Errorf("target request counters exceed the supported range")
			}
			if _, err := tx.ExecContext(ctx, `UPDATE target_quota_counters SET requests=requests+1
WHERE provider_id=? AND model=? AND period=? AND period_start=?`, provider, scope.model, period.name, period.start); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// SettleTargetTokens adds observed source counts once per dispatch, independent
// of logical key/project usage and diagnostic history truncation. The caller owns
// exactly-once settlement, including stream EOF/error/Close. Windows use admission
// time, so a long response cannot consume a slot in one window and tokens in another.
func SettleTargetTokens(provider, model string, admitted time.Time, tokens int64) error {
	if tokens < 0 {
		return fmt.Errorf("target token counts must be non-negative")
	}
	if tokens == 0 {
		return nil
	}
	db, err := DB()
	if err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	_, day, month := quotaPeriods(admitted)
	for _, scope := range []string{"", model} {
		for _, period := range []struct {
			name  string
			start int64
		}{{"day", day}, {"month", month}} {
			if err := addTargetTokensTx(tx, provider, scope, period.name, period.start, tokens); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func addTargetTokensTx(tx *sql.Tx, provider, model, period string, start, tokens int64) error {
	// Retention may prune an elapsed admission window while its response is
	// still in flight. Recreate that old window, never debit the new one.
	result, err := tx.Exec(`INSERT INTO target_quota_counters(provider_id,model,period,period_start,observed_tokens)
VALUES(?,?,?,?,?) ON CONFLICT(provider_id,model,period,period_start) DO UPDATE
SET observed_tokens=observed_tokens+excluded.observed_tokens WHERE observed_tokens<=?`, provider, model, period, start, tokens, math.MaxInt64-tokens)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return err
	} else if affected != 1 {
		return fmt.Errorf("target token settlement exceeds the supported range")
	}
	return nil
}
