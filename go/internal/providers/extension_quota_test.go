package providers

import (
	"context"
	"errors"
	"testing"
)

func TestExtensionQuotaCancellationBeforeCredentialAccess(t *testing.T) {
	rt := &Runtime{}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := (extensionQuotaAdapter{runtime: rt}).Fetch(ctx, QuotaFetchRequest{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled refresh err=%v", err)
	}
}
