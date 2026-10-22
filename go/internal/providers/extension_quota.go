package providers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"regexp"
	"strconv"
	"time"

	"llmgw/internal/iam"

	core "github.com/kayiik/llmgw-core"
)

var ErrQuotaUnsupported = errors.New("provider allowance is unsupported")
var errAllowanceUnavailable = errors.New("provider allowance is unavailable")
var allowanceScopePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$`)
var allowanceSecretPattern = regexp.MustCompile(`(?i)^(sk-|gh[pousr]_|github_pat_|eyj)`)

type extensionQuotaAdapter struct{ runtime *Runtime }

func (a extensionQuotaAdapter) ID() string { return ExtensionTypeAntigravity }

func (a extensionQuotaAdapter) Fetch(ctx context.Context, request QuotaFetchRequest) (QuotaFetchResult, error) {
	if err := ctx.Err(); err != nil {
		return QuotaFetchResult{}, err
	}
	settings, _ := a.runtime.settings.Snapshot()
	if settings == nil || CompanionDaemonType(settings.Providers[request.ProviderID]) != ExtensionTypeAntigravity {
		return QuotaFetchResult{}, ErrQuotaUnsupported
	}
	// Resolve the named connection, never the caller/system/config fallback chain.
	connection, found, err := iam.ProviderConnectionByName(request.PrincipalID, request.ProviderID, request.ConnectionName)
	if err != nil || !found || connection.ID != request.ConnectionID || connection.Status != "active" || request.CredentialRevision <= 0 {
		return QuotaFetchResult{}, errAllowanceUnavailable
	}
	store, err := a.runtime.openCredentials(true)
	if err != nil {
		return QuotaFetchResult{}, errAllowanceUnavailable
	}
	record, err := store.Load(ctx, connection.ID)
	if err != nil || record.Revision != strconv.FormatInt(request.CredentialRevision, 10) {
		return QuotaFetchResult{}, errAllowanceUnavailable
	}
	client, err := a.runtime.extensionClientFor(settings, request.ProviderID)
	if err != nil {
		return QuotaFetchResult{}, errAllowanceUnavailable
	}
	answer, err := client.Allowance(ctx, ExtensionTypeAntigravity, core.CredentialFromRecord(connection.ID, record))
	if err != nil {
		if ctx.Err() != nil {
			return QuotaFetchResult{}, ctx.Err()
		}
		switch core.ClassifyError(err).StatusCode {
		case 404, 405, 501:
			return QuotaFetchResult{}, ErrQuotaUnsupported
		}
		return QuotaFetchResult{}, errAllowanceUnavailable
	}
	if err := ctx.Err(); err != nil {
		return QuotaFetchResult{}, err
	}
	if answer.Status != "observed" || len(answer.Observations) == 0 || len(answer.Observations) > 256 {
		return QuotaFetchResult{}, nil
	}
	now := time.Now().UTC()
	result := QuotaFetchResult{}
	seen := map[string]bool{}
	for _, observation := range answer.Observations {
		if !allowanceScopePattern.MatchString(observation.ModelID) || allowanceSecretPattern.MatchString(observation.ModelID) ||
			(observation.ProjectID != "" && (!allowanceScopePattern.MatchString(observation.ProjectID) || allowanceSecretPattern.MatchString(observation.ProjectID))) ||
			observation.ObservedAt.IsZero() || observation.ObservedAt.After(now.Add(iam.ProviderQuotaMaxClockSkew)) {
			return QuotaFetchResult{}, errAllowanceUnavailable
		}
		if observation.RemainingFraction == nil {
			continue
		}
		fraction := *observation.RemainingFraction
		if math.IsNaN(fraction) || math.IsInf(fraction, 0) || fraction < 0 || fraction > 1 {
			return QuotaFetchResult{}, errAllowanceUnavailable
		}
		observed := observation.ObservedAt
		if observed.After(now) {
			observed = now
		}
		expires := observed.Add(iam.ProviderQuotaDefaultFreshness)
		reset := int64(0)
		if observation.ResetAt != nil {
			if !observation.ResetAt.After(now) {
				return QuotaFetchResult{}, errAllowanceUnavailable
			}
			reset = observation.ResetAt.Unix()
			if observation.ResetAt.Before(expires) {
				expires = *observation.ResetAt
			}
		}
		if !expires.After(now) || expires.Unix() <= now.Unix() {
			return QuotaFetchResult{}, errAllowanceUnavailable
		}
		// Length-prefixed scope avoids ambiguous project/model boundaries. The
		// digest fits IAM's metric/window uniqueness without exposing project IDs.
		digest := sha256.Sum256([]byte(strconv.Itoa(len(observation.ProjectID)) + ":" + observation.ProjectID + observation.ModelID))
		metric := "allowance." + hex.EncodeToString(digest[:])
		if seen[metric] {
			return QuotaFetchResult{}, errAllowanceUnavailable
		}
		seen[metric] = true
		result.Snapshots = append(result.Snapshots, iam.ProviderQuotaSnapshot{
			Metric: metric, Unit: "fraction", Window: "provider", Label: observation.ModelID,
			RemainingValue: &fraction, ResetAt: reset,
			Source: "antigravity_best_effort", Confidence: "unknown",
			RefreshedAt: observed.Unix(), ExpiresAt: expires.Unix(),
			Metadata: map[string]any{"resource": observation.ModelID, "quota_id": metric},
		})
	}
	return result, nil
}
