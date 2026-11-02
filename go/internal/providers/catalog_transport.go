package providers

import (
	"maps"
	"slices"
	"time"

	core "github.com/kayiik/llmgw-core"
)

// CatalogTransportSurfaces describes the expected route from a caller-scoped
// catalog snapshot. A daemon endpoint is not proof of its upstream wire. This
// presentation-only bridge neither grants transparent mode nor certifies the
// eventual attempt, whose route may change after an upstream refusal.
func CatalogTransportSurfaces(provider Provider, row ModelInfo, refreshedAt time.Time, freshFor time.Duration, evaluatedAt time.Time) ([]string, []string, []string) {
	declared, credential := WireDeclaration(provider)
	var facade *ExtensionProviderFacade
	for current := provider; current != nil; {
		switch concrete := current.(type) {
		case *ExtensionProviderFacade:
			facade = concrete
		case *extensionMessagesFacade:
			facade = concrete.facade
		}
		if facade != nil {
			break
		}
		unwrapper, ok := current.(interface{ Unwrap() Provider })
		if !ok {
			break
		}
		current = unwrapper.Unwrap()
	}

	evidence := core.TransportEvidence{Row: CoreModelInfo(row), RefreshedAt: refreshedAt, FreshFor: freshFor}
	if facade == nil {
		return core.ListingSurfaces(declared, credential, evidence, evaluatedAt)
	}
	if len(row.WirePreservation) == 0 || refreshedAt.IsZero() || freshFor <= 0 || !evaluatedAt.Before(refreshedAt.Add(freshFor)) {
		return core.ListingSurfaces(nil, nil, evidence, evaluatedAt)
	}
	if capabilities := row.TypedCapabilities; capabilities != nil && capabilities.Freshness.ExpiresAt != nil && !evaluatedAt.Before(*capabilities.Freshness.ExpiresAt) {
		return core.ListingSurfaces(nil, nil, evidence, evaluatedAt)
	}

	declaration := catalogWireDeclaration{model: row.ID, preservation: maps.Clone(row.WirePreservation)}
	for _, surface := range []core.ModelSurface{core.ModelSurfaceChatCompletions, core.ModelSurfaceResponses, core.ModelSurfaceMessages} {
		if facade.serves(surface) {
			declaration.surfaces = append(declaration.surfaces, surface)
		}
	}
	native, emulated, unknown := core.ListingSurfaces(declaration, nil, evidence, evaluatedAt)
	// An implemented direct endpoint with no preservation result is not a
	// demonstrated conversion. Other, unserved client surfaces can still be
	// classified by the existing conversion planner.
	for _, path := range row.SupportedSurfaces {
		surface := core.ParseSurfacePath(path)
		state := row.WirePreservation[surface]
		if !slices.Contains(declaration.surfaces, surface) || state == core.SupportSupported || state == core.SupportUnsupported {
			continue
		}
		matches := func(candidate string) bool { return core.ParseSurfacePath(candidate) == surface }
		var canonical string
		for _, candidate := range append(slices.Clone(native), emulated...) {
			if matches(candidate) {
				canonical = candidate
				break
			}
		}
		if canonical != "" {
			native = slices.DeleteFunc(native, matches)
			emulated = slices.DeleteFunc(emulated, matches)
			unknown = append(unknown, canonical)
		}
	}
	return native, emulated, unknown
}

// Reuse the declaration-only operations; this snapshot cannot issue a request.
type catalogWireDeclaration struct {
	gatewayDeclaration
	model        string
	surfaces     []core.ModelSurface
	preservation map[core.ModelSurface]core.SupportState
}

func (d catalogWireDeclaration) NativeSurfaces(model string) []core.ModelSurface {
	if model != d.model {
		return nil
	}
	return slices.Clone(d.surfaces)
}

func (d catalogWireDeclaration) PreservesWire(model string, surface core.ModelSurface) bool {
	return model == d.model && slices.Contains(d.surfaces, surface) && d.preservation[surface] == core.SupportSupported
}
