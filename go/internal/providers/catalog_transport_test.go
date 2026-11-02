package providers

import (
	"reflect"
	"slices"
	"testing"
	"time"

	core "github.com/kayiik/llmgw-core"
)

func TestExtensionCatalogTransportUsesModelWireEvidence(t *testing.T) {
	now := time.Date(2026, time.October, 29, 2, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name, provider, surface, native string
	}{
		{"codex responses", ExtensionTypeCodex, "/responses", "/v1/responses"},
		{"copilot chat", ExtensionTypeCopilot, "/chat/completions", "/v1/chat/completions"},
	} {
		t.Run(test.name, func(t *testing.T) {
			facade := &ExtensionProviderFacade{providerID: test.provider}
			row := ModelInfo{ID: "model", SupportedSurfaces: []string{test.surface}, WirePreservation: map[core.ModelSurface]core.SupportState{
				core.ModelSurfaceChatCompletions: core.SupportUnsupported,
				core.ModelSurfaceResponses:       core.SupportUnsupported,
				core.ModelSurfaceMessages:        core.SupportUnsupported,
			}}
			row.WirePreservation[core.ParseSurfacePath(test.surface)] = core.SupportSupported
			native, emulated, unknown := CatalogTransportSurfaces(facade, row, now, time.Hour, now)
			if !reflect.DeepEqual(native, []string{test.native}) || len(emulated) != 2 || len(unknown) != 0 {
				t.Fatalf("snapshot classification: native=%v translated=%v unknown=%v", native, emulated, unknown)
			}
			// Catalog evidence must not silently broaden the execution declaration.
			declaration, _ := WireDeclaration(facade)
			if wire, ok := declaration.(interface {
				PreservesWire(string, core.ModelSurface) bool
			}); ok && wire.PreservesWire(row.ID, core.ParseSurfacePath(test.surface)) {
				t.Fatal("listing snapshot broadened the execution wire declaration")
			}
		})
	}
}

func TestExtensionCatalogTransportMissingStaleAndPartialEvidence(t *testing.T) {
	now := time.Date(2026, time.October, 29, 2, 0, 0, 0, time.UTC)
	facade := &ExtensionProviderFacade{providerID: ExtensionTypeCodex}
	for _, test := range []struct {
		name string
		row  ModelInfo
		at   time.Time
	}{
		{"missing", ModelInfo{ID: "model", SupportedSurfaces: []string{"/responses"}}, now},
		{"stale", ModelInfo{ID: "model", SupportedSurfaces: []string{"/responses"}, WirePreservation: map[core.ModelSurface]core.SupportState{core.ModelSurfaceResponses: core.SupportSupported}}, now.Add(-time.Hour)},
		{"missing timestamp", ModelInfo{ID: "model", SupportedSurfaces: []string{"/responses"}, WirePreservation: map[core.ModelSurface]core.SupportState{core.ModelSurfaceResponses: core.SupportSupported}}, time.Time{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			native, emulated, unknown := CatalogTransportSurfaces(facade, test.row, test.at, time.Hour, now)
			if len(native) != 0 || len(emulated) != 0 || len(unknown) != 3 {
				t.Fatalf("unconfirmed snapshot classified: native=%v translated=%v unknown=%v", native, emulated, unknown)
			}
		})
	}
	row := ModelInfo{ID: "model", SupportedSurfaces: []string{"/chat/completions", "/responses"}, WirePreservation: map[core.ModelSurface]core.SupportState{core.ModelSurfaceResponses: core.SupportSupported}}
	native, emulated, unknown := CatalogTransportSurfaces(facade, row, now, time.Hour, now)
	if !slices.Contains(native, "/v1/responses") || slices.Contains(emulated, "/v1/chat/completions") || !slices.Contains(unknown, "/v1/chat/completions") {
		t.Fatalf("partial proof invented a direct-endpoint conversion: native=%v translated=%v unknown=%v", native, emulated, unknown)
	}
}

func TestCatalogWireEvidenceRoundTripIsIndependent(t *testing.T) {
	row := ModelInfo{ID: "owner-a-model", WirePreservation: map[core.ModelSurface]core.SupportState{core.ModelSurfaceResponses: core.SupportSupported}}
	converted := CoreModelInfo(row)
	row.WirePreservation[core.ModelSurfaceResponses] = core.SupportUnsupported
	if converted.WirePreservation[core.ModelSurfaceResponses] != core.SupportSupported {
		t.Fatal("gateway-to-core shared the caller snapshot map")
	}
	back := gatewayModelInfo(converted)
	converted.WirePreservation[core.ModelSurfaceResponses] = core.SupportUnsupported
	if back.WirePreservation[core.ModelSurfaceResponses] != core.SupportSupported {
		t.Fatal("core-to-gateway shared the caller snapshot map")
	}
	if CoreModelInfo(ModelInfo{}).WirePreservation != nil || gatewayModelInfo(core.ModelInfo{}).WirePreservation != nil {
		t.Fatal("missing evidence became an allocated observation")
	}
}
