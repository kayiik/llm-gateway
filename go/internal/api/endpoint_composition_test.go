package api

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	core "github.com/kayiik/llmgw-core"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
)

func endpointCompositionFixture(t *testing.T) *httptest.Server {
	t.Helper()
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	iam.ResetForTests()
	t.Cleanup(iam.ResetForTests)
	providers.InstallForTests(t)
	previous := *config.Get()
	t.Cleanup(func() { config.Update(func(s *config.Settings) { *s = previous }) })
	config.Update(func(s *config.Settings) {
		s.APIKey = "admin-secret"
		s.AllowUnauthenticatedAPI = false
		s.Providers = map[string]*config.ProviderConfig{"echo": {Type: "echo"}}
		s.Endpoints = map[string]*config.EndpointConfig{}
	})
	if _, err := iam.Initialize(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(Runtime{}))
	t.Cleanup(server.Close)
	return server
}

func TestEndpointCompositionPersistsReferencesAndResolvesCurrentLeaves(t *testing.T) {
	server := endpointCompositionFixture(t)
	save := func(name string, members []map[string]any) map[string]any {
		t.Helper()
		status, result := jsonRequest(t, server.URL+"/admin/api/endpoints", http.MethodPost, "admin-secret", map[string]any{"name": name, "failover": members})
		if status != http.StatusOK {
			t.Fatalf("save %s: status=%d result=%+v", name, status, result)
		}
		return result
	}
	save("child", []map[string]any{{"provider": "echo", "model": "echo-strong"}, {"provider": "echo", "model": "echo-small"}})
	result := save("parent", []map[string]any{{"route": "CHILD"}, {"provider": "echo", "model": "echo-strong"}})
	if result["members"] != float64(2) || result["expanded_members"] != float64(3) {
		t.Fatalf("wrong source/expanded lengths: %+v", result)
	}
	if config.Get().Endpoints["parent"].Failover[0].Route != "CHILD" {
		t.Fatal("reference was replaced with a stale copied list")
	}
	resolution, err := resolveAs("parent", &config.Principal{RoutesOnly: true, AllowedRoutes: []string{"parent"}})
	if err != nil || len(resolution.Targets) != 3 || resolution.Category != "parent" || resolution.Targets[1].Model != "echo-small" {
		t.Fatalf("nested resolution: %+v err=%v", resolution, err)
	}
	if _, err := resolveAs("child", &config.Principal{RoutesOnly: true, AllowedRoutes: []string{"parent"}}); err == nil {
		t.Fatal("parent composition granted direct access to child route")
	}
	save("child", []map[string]any{{"provider": "echo", "model": "echo-small"}})
	resolution, err = resolveAs("parent", nil)
	if err != nil || len(resolution.Targets) != 2 || resolution.Targets[0].Model != "echo-small" {
		t.Fatalf("parent did not observe published child edit: %+v err=%v", resolution, err)
	}
	status, result := jsonRequest(t, server.URL+"/admin/api/endpoints/child", http.MethodDelete, "admin-secret", nil)
	if status != http.StatusConflict || config.Get().Endpoints["child"] == nil {
		t.Fatalf("referenced route deletion escaped: %d %+v", status, result)
	}
	before := config.Generation()
	status, _ = jsonRequest(t, server.URL+"/admin/api/endpoints", http.MethodPost, "admin-secret", map[string]any{"name": "child", "failover": []map[string]any{{"route": "parent"}}})
	if status != http.StatusBadRequest || config.Generation() != before {
		t.Fatalf("cyclic update published: status=%d generation=%d/%d", status, before, config.Generation())
	}
	for _, member := range []map[string]any{{"route": "missing"}, {"route": "child", "provider": "echo", "model": "echo-strong"}, {"route": "child", "provider": ""}, {"route": "child", "allow_unverified": false}} {
		status, result = jsonRequest(t, server.URL+"/admin/api/endpoints", http.MethodPost, "admin-secret", map[string]any{"name": "invalid", "failover": []map[string]any{member}})
		if status != http.StatusBadRequest || config.Get().Endpoints["invalid"] != nil {
			t.Fatalf("invalid reference accepted: %d %+v", status, result)
		}
	}
	status, state := jsonRequest(t, server.URL+"/admin/api/state", http.MethodGet, "admin-secret", nil)
	if status != http.StatusOK {
		t.Fatalf("state status=%d", status)
	}
	endpoint := state["endpoints"].(map[string]any)["parent"].(map[string]any)
	if endpoint["failover"].([]any)[0].(map[string]any)["route"] != "CHILD" || len(endpoint["expanded_failover"].([]any)) != 2 {
		t.Fatalf("state lost authored reference/current expansion: %+v", endpoint)
	}
}

func TestEndpointCapabilityPolicy(t *testing.T) {
	members := []config.EndpointMember{{Provider: "first", Model: "a"}, {Provider: "second", Model: "b"}}
	chat := providers.ModelInfo{Capabilities: map[string]any{"chat": true, "tools": true, "streaming": true}, SupportedSurfaces: []string{"/v1/responses"}}
	for _, test := range []struct {
		name    string
		next    providers.ModelInfo
		refuse  bool
		warning string
	}{
		{"video", providers.ModelInfo{Capabilities: map[string]any{"video": true}}, true, ""},
		{"embedding", providers.ModelInfo{SupportedSurfaces: []string{"/v1/embeddings"}}, true, ""},
		{"optional features", providers.ModelInfo{Capabilities: map[string]any{"chat": true, "tools": false, "streaming": false}}, false, "different tools support"},
		{"unknown", providers.ModelInfo{}, false, "unknown"},
		{"image input is not image generation", providers.ModelInfo{Capabilities: map[string]any{"vision": true}, SupportedSurfaces: []string{"/v1/messages"}}, false, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			warnings, err := endpointCapabilityWarnings(members, func(member config.EndpointMember) (providers.ModelInfo, bool) {
				if member.Provider == "first" {
					return chat, true
				}
				return test.next, true
			})
			if (err != nil) != test.refuse || (test.warning != "" && !strings.Contains(strings.Join(warnings, " "), test.warning)) {
				t.Fatalf("warnings=%v err=%v", warnings, err)
			}
		})
	}
	caps, surfaces := categoryPresentationMetadata(map[string][]providers.ModelInfo{"first": {{ID: "a", Capabilities: chat.Capabilities, SupportedSurfaces: chat.SupportedSurfaces}}, "second": {{ID: "b"}}}, members)
	if !reflect.DeepEqual(caps, chat.Capabilities) || !reflect.DeepEqual(surfaces, chat.SupportedSurfaces) {
		t.Fatalf("route did not advertise first member: caps=%v surfaces=%v", caps, surfaces)
	}
}

func TestEndpointCapabilityValidationChecksAffectedParents(t *testing.T) {
	server := endpointCompositionFixture(t)
	original := catalogLookupForPrincipal
	catalogLookupForPrincipal = func(_ string, model string, _ *config.Principal) (providers.ModelInfo, bool) {
		caps := map[string]any{"chat": true, "tools": model != "echo-small", "streaming": model != "echo-small"}
		if model == "video" {
			caps = map[string]any{"video": true}
		}
		return providers.ModelInfo{ID: model, Capabilities: caps}, true
	}
	t.Cleanup(func() { catalogLookupForPrincipal = original })
	save := func(name string, members []map[string]any) (int, map[string]any) {
		return jsonRequest(t, server.URL+"/admin/api/endpoints", http.MethodPost, "admin-secret", map[string]any{"name": name, "failover": members})
	}
	status, result := save("child", []map[string]any{{"provider": "echo", "model": "echo-small"}})
	if status != http.StatusOK {
		t.Fatalf("child: %d %+v", status, result)
	}
	status, result = save("parent", []map[string]any{{"provider": "echo", "model": "echo-strong"}, {"route": "child"}})
	if status != http.StatusOK || len(result["warnings"].([]any)) != 2 {
		t.Fatalf("optional feature differences blocked or not warned: %d %+v", status, result)
	}
	before := config.Generation()
	status, result = save("child", []map[string]any{{"provider": "echo", "model": "video"}})
	if status != http.StatusBadRequest || config.Generation() != before || config.Get().Endpoints["child"].Failover[0].Model != "echo-small" {
		t.Fatalf("child update broke parent's operation family: %d %+v", status, result)
	}
}

func TestEndpointCapabilitiesRespectTypedEvidenceAndCatalogAliases(t *testing.T) {
	members := []config.EndpointMember{{Provider: "first", Model: "a"}, {Provider: "second", Model: "b"}}
	typedChat := &core.ModelCapabilities{SchemaVersion: core.ModelCapabilitiesSchemaVersion,
		Operations: core.ModelOperationCapabilities{Chat: core.SupportSupported, Image: core.SupportUnsupported},
		Tools:      core.SupportSupported, Streaming: core.SupportSupported}
	for _, test := range []struct {
		name        string
		first, next providers.ModelInfo
		refuse      bool
		warning     string
	}{
		{"typed video", providers.ModelInfo{TypedCapabilities: typedChat}, providers.ModelInfo{TypedCapabilities: &core.ModelCapabilities{SchemaVersion: 1, Operations: core.ModelOperationCapabilities{Video: core.SupportSupported, Chat: core.SupportUnsupported}}}, true, ""},
		{"short responses", providers.ModelInfo{SupportedSurfaces: []string{"/responses"}}, providers.ModelInfo{Capabilities: map[string]any{"video": true}}, true, ""},
		{"websocket responses", providers.ModelInfo{SupportedSurfaces: []string{"ws:/responses"}}, providers.ModelInfo{Capabilities: map[string]any{"video": true}}, true, ""},
		{"tool_calls alias", providers.ModelInfo{SupportedSurfaces: []string{"/messages"}, Capabilities: map[string]any{"tool_calls": true}}, providers.ModelInfo{SupportedSurfaces: []string{"/chat/completions"}, Capabilities: map[string]any{"tool_calls": false}}, false, "different tools support"},
		{"typed optional", providers.ModelInfo{TypedCapabilities: typedChat}, providers.ModelInfo{TypedCapabilities: &core.ModelCapabilities{SchemaVersion: 1, Operations: core.ModelOperationCapabilities{Chat: core.SupportSupported}, Tools: core.SupportUnsupported, Streaming: core.SupportUnsupported}}, false, "different streaming support"},
		{"typed overrides legacy", providers.ModelInfo{TypedCapabilities: typedChat, Capabilities: map[string]any{"image": true}}, providers.ModelInfo{Capabilities: map[string]any{"image": true}}, true, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			warnings, err := endpointCapabilityWarnings(members, func(member config.EndpointMember) (providers.ModelInfo, bool) {
				if member.Provider == "first" {
					return test.first, true
				}
				return test.next, true
			})
			if (err != nil) != test.refuse || (test.warning != "" && !strings.Contains(strings.Join(warnings, " "), test.warning)) {
				t.Fatalf("warnings=%v err=%v", warnings, err)
			}
		})
	}
	expired := *typedChat
	past := time.Now().Add(-time.Hour)
	expired.Freshness.ExpiresAt = &past
	if families := endpointOperationFamilies(providers.ModelInfo{TypedCapabilities: &expired, Capabilities: map[string]any{"image": true}}); len(families) != 0 {
		t.Fatalf("expired evidence was revived through legacy metadata: %v", families)
	}
}
