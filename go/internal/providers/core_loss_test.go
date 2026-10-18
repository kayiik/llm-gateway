package providers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	core "github.com/kayiik/llmgw-core"
)

func TestCoreInputLossRefusalKeepsItsStatusAndReport(t *testing.T) {
	loss := &core.LossPolicyError{Losses: []core.Loss{{Path: "messages.0.content.0"}}}
	for _, tc := range []struct {
		name     string
		mapError func(error) error
	}{
		{"Google", (&googleProvider{}).failure},
		{"Ollama", func(err error) error { return ollamaFailure(context.Background(), err) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.mapError(fmt.Errorf("runtime: %w", loss))
			var observed *core.LossPolicyError
			var invocation *InvocationError
			if !errors.As(err, &observed) || observed != loss {
				t.Fatal("preflight refusal lost its structured findings")
			}
			if !errors.As(err, &invocation) || invocation.Status != http.StatusBadRequest || !invocation.FailoverEligible || invocation.Retryable || invocation.CircuitFailure || IsConfig(err) {
				t.Fatalf("preflight refusal classification: %v", err)
			}
		})
	}
}
