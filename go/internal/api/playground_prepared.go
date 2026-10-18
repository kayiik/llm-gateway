package api

import (
	"encoding/json"
	"net/http"
	"slices"

	"llmgw/internal/config"
	"llmgw/internal/providers"
	"llmgw/internal/router"

	core "github.com/kayiik/llmgw-core"
)

func preparePlaygroundRequest(r *http.Request, principal *config.Principal, payload map[string]any, model string, surface core.ModelSurface, settings *config.Settings, generation uint64, resolution router.Resolution, targets []router.Target) (*router.PreparedRequest, error) {
	badRequest := func(err error) (*router.PreparedRequest, error) {
		return nil, &providers.InvocationError{Msg: err.Error(), Status: http.StatusBadRequest}
	}
	mode, err := requestedTransportMode(r)
	if err != nil {
		return badRequest(err)
	}
	preference, err := requestedCompatibility(r)
	if err != nil {
		return badRequest(err)
	}
	allow, err := routeAdaptation(settings, resolution.Category, ingressPath(surface), preference)
	if err != nil {
		return badRequest(err)
	}
	stream, _ := payload["stream"].(bool)
	if mode == core.TransportRequirementTransparent {
		target, err := exactNativeTransparentTarget(model, ingressPath(surface), resolution, callerOf(principal))
		if err != nil {
			return badRequest(err)
		}
		if !slices.Contains(targets, target) || stream {
			return nil, &providers.InvocationError{Msg: "The playground cannot preserve this transparent request.", Status: http.StatusBadRequest}
		}
		targets, allow = []router.Target{target}, false
	} else if surface == core.ModelSurfaceChatCompletions && settings.GatewayPreamble != "" {
		messages := []any{map[string]any{"role": "system", "content": settings.GatewayPreamble}}
		switch original := payload["messages"].(type) {
		case []any:
			messages = append(messages, original...)
		case []map[string]any:
			for _, message := range original {
				messages = append(messages, message)
			}
		}
		payload["messages"] = messages
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return badRequest(err)
	}
	callMode := core.CallModeInvoke
	if stream {
		callMode = core.CallModeStream
	}
	header := http.Header{}
	for _, name := range []string{"anthropic-version", "anthropic-beta"} {
		header[name] = append([]string(nil), r.Header.Values(name)...)
	}
	return router.Current().PrepareRequest(governed(r.Context(), principal), targets, callerOf(principal), core.Request{
		Surface: surface, Model: model, Body: raw, ContentType: core.ContentTypeJSON, Header: header,
	}, router.PreparedOptions{
		Generation:  generation,
		Preparation: core.CallPreparationOptions{Mode: callMode, AllowAdaptation: allow},
		Policy:      core.CallPolicy{AllowAdaptation: allow, RequireWirePreservation: mode == core.TransportRequirementTransparent, RequireIncremental: stream},
	})
}
