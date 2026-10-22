package api

import (
	"fmt"
	"sort"
	"strings"
	"time"

	core "github.com/kayiik/llmgw-core"

	"llmgw/internal/config"
	"llmgw/internal/providers"
)

// A route advertises its first target; later targets may have fewer optional
// features. Authoring advice must not turn unknown catalog data into support.
func endpointCapabilityWarnings(members []config.EndpointMember, lookup func(config.EndpointMember) (providers.ModelInfo, bool)) ([]string, error) {
	if len(members) == 0 {
		return nil, nil
	}
	first, found := lookup(members[0])
	baseline := endpointOperationFamilies(first)
	warnings := []string{}
	for index, member := range members {
		row, known := first, found
		if index > 0 {
			row, known = lookup(member)
		}
		families := endpointOperationFamilies(row)
		label := member.Provider + "/" + member.Model
		if !known || len(families) == 0 {
			warnings = append(warnings, fmt.Sprintf("Operation capabilities are unknown for member %d (%s).", index+1, label))
		}
		if index == 0 {
			continue
		}
		if len(baseline) > 0 && len(families) > 0 {
			shared := false
			for family := range baseline {
				shared = shared || families[family]
			}
			if !shared {
				return nil, fmt.Errorf("route member %d (%s) serves %s, incompatible with the first member's %s operations", index+1, label, endpointFamilyLabel(families), endpointFamilyLabel(baseline))
			}
		}
		for _, capability := range []string{"tools", "streaming"} {
			initial, initialKnown := endpointOptionalCapability(first, capability)
			current, currentKnown := endpointOptionalCapability(row, capability)
			if initialKnown && currentKnown && initial != current {
				warnings = append(warnings, fmt.Sprintf("Member %d (%s) has different %s support from the first member; requests requiring that feature may skip it or fail.", index+1, label, capability))
			}
		}
	}
	return warnings, nil
}

func endpointOptionalCapability(row providers.ModelInfo, name string) (bool, bool) {
	caps := endpointModelCapabilities(row)
	value := caps.Tools
	if name == "streaming" {
		value = caps.Streaming
		if row.TypedCapabilities == nil && value == core.SupportUnknown {
			legacy, known := row.Capabilities["stream"].(bool)
			return legacy, known
		}
	}
	return value == core.SupportSupported, value.IsKnown()
}

func endpointOperationFamilies(row providers.ModelInfo) map[string]bool {
	out := map[string]bool{}
	caps := endpointModelCapabilities(row)
	for operation, family := range map[core.ModelOperation]string{
		core.ModelOperationChat: "conversation", core.ModelOperationTokenCount: "conversation",
		core.ModelOperationImage: "image generation", core.ModelOperationVideo: "video generation",
		core.ModelOperationEmbeddings: "embedding", core.ModelOperationAudioOut: "speech generation",
		core.ModelOperationAudioIn: "transcription",
	} {
		if caps.OperationCompatibility(operation) == core.SupportSupported {
			out[family] = true
		}
	}
	if caps.Operations.Chat == core.SupportUnknown && (caps.Surfaces.ChatCompletions == core.SupportSupported || caps.Surfaces.Responses == core.SupportSupported || caps.Surfaces.Messages == core.SupportSupported) {
		out["conversation"] = true
	}
	// Realtime has no operation field in capability schema v1.
	if row.TypedCapabilities == nil {
		for _, surface := range row.SupportedSurfaces {
			switch strings.TrimPrefix(strings.ToLower(strings.TrimSpace(surface)), "/v1") {
			case "/realtime", "/realtime/calls":
				out["realtime"] = true
			}
		}
	}
	return out
}

func endpointModelCapabilities(row providers.ModelInfo) *core.ModelCapabilities {
	if row.TypedCapabilities != nil {
		if !core.PreparedCapabilityDenialsUsable(row.TypedCapabilities, time.Now()) {
			return &core.ModelCapabilities{}
		}
		return row.TypedCapabilities
	}
	return providers.AdaptModelCapabilities(row.Capabilities, row.SupportedSurfaces, time.Time{}, time.Time{})
}

func endpointFamilyLabel(families map[string]bool) string {
	names := make([]string, 0, len(families))
	for family := range families {
		names = append(names, family)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

func endpointReferences(endpoints map[string]*config.EndpointConfig, from, target string, visited map[string]bool) bool {
	if visited[from] || endpoints[from] == nil {
		return false
	}
	visited[from] = true
	for _, member := range endpoints[from].Failover {
		if member.Route == "" {
			continue
		}
		if strings.EqualFold(member.Route, target) {
			return true
		}
		for name := range endpoints {
			if strings.EqualFold(name, member.Route) && endpointReferences(endpoints, name, target, visited) {
				return true
			}
		}
	}
	return false
}
