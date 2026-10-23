package api

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/providers"
	"llmgw/internal/router"

	core "github.com/kayiik/llmgw-core"
)

const transportModeHeader = "X-LLMGW-Transport-Mode"

// transportCatalogFreshness is how long a catalog row stays fresh evidence
// for transport planning after its catalog was refreshed: the gateway's
// catalog hour, whatever freshness the row itself carries.
const transportCatalogFreshness = time.Hour

var errTransportMode = errors.New("X-LLMGW-Transport-Mode must be transparent when present")

func requestedTransportMode(r *http.Request) (core.TransportRequirement, error) {
	value, _, valid := singlePolicyHeader(r.Header, transportModeHeader)
	if !valid {
		return "", errTransportMode
	}
	requirement, err := core.ParseTransportRequirement(value)
	if err != nil {
		return "", errTransportMode
	}
	compatibility, err := requestedCompatibility(r)
	if err != nil {
		return "", err
	}
	if requirement == core.TransportRequirementTransparent && compatibility == "allow" {
		return "", errors.New("transparent mode cannot allow compatibility adaptation")
	}
	return requirement, nil
}

func exactNativeTransparentTarget(model, surface string, resolution router.Resolution, caller core.Caller) (router.Target, error) {
	if !isExactProviderModelResolution(model, resolution) {
		return router.Target{}, errors.New("transparent mode requires an exact provider/model target; endpoints and aliases are not accepted")
	}
	target := resolution.Targets[0]
	if config.Get().Providers[target.Provider] == nil {
		return router.Target{}, errors.New("transparent mode requires a configured provider")
	}
	row, ok := providers.CatalogCachedLookupForPrincipal(target.Provider, target.Model, caller)
	if !ok {
		return router.Target{}, errors.New("transparent mode requires a catalog-confirmed native surface")
	}
	provider, credential, err := transportDeclaration(target.Provider, caller)
	if err != nil {
		return router.Target{}, errors.New("transparent mode could not resolve the provider interface")
	}
	requested := core.ParseSurfacePath(surface)
	interfaces := core.TransportInterfaces(provider, credential, target.Model, row.SupportedSurfaces)
	plan := planTransparent(
		row, providers.CatalogRefreshedAtForPrincipal(target.Provider, caller), interfaces, requested, time.Now(),
	)
	if plan.Disposition == core.TransportNative {
		return target, nil
	}
	if plan.Reason != core.TransportRejectNativeUnconfirmed {
		return router.Target{}, errors.New("the requested client surface is not native for this provider/model target")
	}
	if anonymousZen, _ := providers.AnonymousZenForPrincipal(target.Provider, caller); anonymousZen {
		return router.Target{}, errors.New("transparent mode is unavailable for OpenCode Zen anonymous adaptation")
	}
	if !slices.Contains(interfaces, core.TransportInterface{Surface: requested, Native: core.SupportSupported}) {
		return router.Target{}, errors.New("the requested client surface is not native for this provider/model target")
	}
	return router.Target{}, errors.New("transparent mode requires fresh, catalog-confirmed native capability evidence")
}

// planTransparent plans a transparent request of an exact target from its
// cached catalog row.
func planTransparent(
	row providers.ModelInfo, refreshedAt time.Time, interfaces []core.TransportInterface,
	surface core.ModelSurface, evaluatedAt time.Time,
) core.TransportPlan {
	return core.PlanTransport(core.TransportPlanRequest{
		Operation: core.ModelOperationChat, Surface: surface, EvaluatedAt: evaluatedAt, ExactTarget: true,
		Capabilities: transportEvidence(row, refreshedAt).Capabilities(),
		Interfaces:   interfaces, Requirement: core.TransportRequirementTransparent,
	})
}

func targetTransportMode(target router.Target, caller core.Caller, surface string) string {
	var evidence *core.TransportEvidence
	if row, found := providers.CatalogCachedLookupForPrincipal(target.Provider, target.Model, caller); found {
		cached := transportEvidence(row, providers.CatalogRefreshedAtForPrincipal(target.Provider, caller))
		evidence = &cached
	}
	provider, credential, _ := transportDeclaration(target.Provider, caller)
	return core.ResponseTransportMode(
		provider, credential, target.Model, core.ParseSurfacePath(surface), evidence, time.Now(),
	)
}

// modelTransportSurfaces classifies a /v1/models row's chat surfaces, with
// the capabilities and surfaces the list presents for it.
func modelTransportSurfaces(
	providerID string,
	caller core.Caller,
	model providers.ModelInfo,
	refreshedAt time.Time,
	capabilities map[string]any,
	surfaces []string,
	evaluatedAt time.Time,
) ([]string, []string, []string) {
	provider, credential, _ := transportDeclaration(providerID, caller)
	model.Capabilities, model.SupportedSurfaces = capabilities, surfaces
	native, emulated, unknown := core.ListingSurfaces(provider, credential, transportEvidence(model, refreshedAt), evaluatedAt)
	// This signaling path is served directly by the gateway rather than the
	// core conversation adapters. Only a current explicit API declaration is
	// positive listing evidence; neither the provider label nor model name is.
	for _, surface := range surfaces {
		if strings.TrimPrefix(surface, "/v1") != "/realtime/calls" {
			continue
		}
		if providers.SupportsRealtimeHTTPTransport(providerID) && realtimeCatalogSupport(model, refreshedAt, evaluatedAt) == core.SupportSupported {
			native = append(native, realtimeCallsPath)
		} else {
			unknown = append(unknown, realtimeCallsPath)
		}
		break
	}
	return native, emulated, unknown
}

// transportDeclaration returns the core provider whose declarations say
// which surfaces providerID forwards in their own wire for caller, and the
// credential its requests carry; see providers.WireDeclaration.
func transportDeclaration(providerID string, caller core.Caller) (core.Provider, *core.Credential, error) {
	provider, err := providers.GetProviderForPrincipal(providerID, caller)
	if err != nil {
		return nil, nil, err
	}
	declared, credential := providers.WireDeclaration(provider)
	return declared, credential, nil
}

// transportEvidence is what a cached catalog row says for transport
// planning: fresh for the gateway's catalog hour after its refresh.
func transportEvidence(row providers.ModelInfo, refreshedAt time.Time) core.TransportEvidence {
	return core.TransportEvidence{
		Row: providers.CoreModelInfo(row), RefreshedAt: refreshedAt, FreshFor: transportCatalogFreshness,
	}
}

func rejectTransparentStream(w http.ResponseWriter, stream bool) bool {
	if !stream {
		return false
	}
	writeError(w, http.StatusBadRequest, "Transparent streaming is not supported yet; use native mode or a non-streaming transparent request.")
	return true
}
