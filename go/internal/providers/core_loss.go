package providers

import (
	"errors"
	"net/http"

	core "github.com/kayiik/llmgw-core"
)

type inputLossError struct {
	*InvocationError
	loss *core.LossPolicyError
}

func (e *inputLossError) Unwrap() []error { return []error{e.InvocationError, e.loss} }

// These provider-local refusals precede inference. Keep their findings while
// allowing a route to try another target, without blaming provider health.
func inputLossRefusal(err error) error {
	var loss *core.LossPolicyError
	if !errors.As(err, &loss) {
		return nil
	}
	return &inputLossError{
		InvocationError: &InvocationError{Msg: loss.Error(), Status: http.StatusBadRequest, FailoverEligible: true},
		loss:            loss,
	}
}
