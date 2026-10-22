package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestEndpointReferencesOrderingAndIsolation(t *testing.T) {
	a := EndpointMember{Provider: "unconfigured", Model: "a", AllowUnverified: true}
	b := EndpointMember{Provider: "other", Model: "b"}
	endpoints := map[string]*EndpointConfig{
		"outer":  {Ingress: []string{"/v1/messages"}, Failover: []EndpointMember{b, {Route: "CHILD"}, a, {Route: "child"}, {Route: "empty"}}},
		"child":  {Ingress: []string{"/v1/responses"}, AllowAdaptation: true, Failover: []EndpointMember{{Route: "nested"}, b}},
		"nested": {Failover: []EndpointMember{a}},
		"empty":  {},
	}
	want := []EndpointMember{b, a, b, a, a, b}
	got, err := ExpandEndpointMembers(endpoints, "OUTER")
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("expanded %v, %v; want %v", got, err, want)
	}
	got[0].Model = "mutated"
	if endpoints["outer"].Failover[0] != b || endpoints["outer"].Failover[1].Route != "CHILD" || endpoints["outer"].AllowAdaptation {
		t.Fatal("expansion mutated source members or child policy leaked")
	}
	endpoints["nested"].Failover[0].Model = "fresh"
	got, err = ExpandEndpointMembers(endpoints, "outer")
	if err != nil || got[1].Model != "fresh" {
		t.Fatalf("expansion did not use current snapshot: %v, %v", got, err)
	}
	if err := ValidateEndpointReferences(endpoints); err != nil {
		t.Fatal(err)
	}
}

func TestEndpointReferencesRejectInvalidGraphs(t *testing.T) {
	for _, tc := range []struct {
		name      string
		endpoints map[string]*EndpointConfig
		message   string
	}{
		{"missing", map[string]*EndpointConfig{"a": {Failover: []EndpointMember{{Route: "missing"}}}}, "missing"},
		{"self", map[string]*EndpointConfig{"a": {Failover: []EndpointMember{{Route: "A"}}}}, "cycle"},
		{"cycle", map[string]*EndpointConfig{"a": {Failover: []EndpointMember{{Route: "b"}}}, "b": {Failover: []EndpointMember{{Route: "a"}}}}, "cycle"},
		{"ambiguous", map[string]*EndpointConfig{"a": {Failover: []EndpointMember{{Route: "CHILD"}}}, "Child": {}, "child": {}}, "ambiguous"},
		{"mixed provider", map[string]*EndpointConfig{"a": {Failover: []EndpointMember{{Route: "b", Provider: "p"}}}, "b": {}}, "mixes"},
		{"mixed model", map[string]*EndpointConfig{"a": {Failover: []EndpointMember{{Route: "b", Model: "m"}}}, "b": {}}, "mixes"},
		{"mixed flag", map[string]*EndpointConfig{"a": {Failover: []EndpointMember{{Route: "b", AllowUnverified: true}}}, "b": {}}, "mixes"},
		{"nil", map[string]*EndpointConfig{"a": nil}, "missing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateEndpointReferences(tc.endpoints); err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("expected %s, got %v", tc.message, err)
			}
		})
	}
	endpoints := map[string]*EndpointConfig{"Child": {Failover: []EndpointMember{{Provider: "p", Model: "exact"}}}, "child": {}}
	got, err := ExpandEndpointMembers(endpoints, "Child")
	if err != nil || len(got) != 1 || got[0].Model != "exact" {
		t.Fatalf("exact match must win: %v, %v", got, err)
	}
	if _, err := ExpandEndpointMembers(endpoints, "absent"); err == nil {
		t.Fatal("missing root accepted")
	}
}

func TestEndpointReferencesExpansionBounds(t *testing.T) {
	endpoints := map[string]*EndpointConfig{"0": {Failover: []EndpointMember{{Provider: "p", Model: "m"}}}}
	for i := 1; i <= 13; i++ {
		child := fmt.Sprint(i - 1)
		endpoints[fmt.Sprint(i)] = &EndpointConfig{Failover: []EndpointMember{{Route: child}, {Route: child}}}
	}
	if got, err := ExpandEndpointMembers(endpoints, "12"); err != nil || len(got) != 4096 {
		t.Fatalf("boundary expansion: %d, %v", len(got), err)
	}
	if _, err := ExpandEndpointMembers(endpoints, "13"); err == nil {
		t.Fatal("exponential expansion was not bounded")
	}
	endpoints = map[string]*EndpointConfig{"0": {}}
	for i := 1; i <= 128; i++ {
		endpoints[fmt.Sprint(i)] = &EndpointConfig{Failover: []EndpointMember{{Route: fmt.Sprint(i - 1)}}}
	}
	if _, err := ExpandEndpointMembers(endpoints, "127"); err != nil {
		t.Fatal(err)
	}
	if _, err := ExpandEndpointMembers(endpoints, "128"); err == nil {
		t.Fatal("nesting was not bounded")
	}
	// Visiting the short path first must not let memoization bypass the depth cap.
	endpoints["root"] = &EndpointConfig{Failover: []EndpointMember{{Route: "0"}, {Route: "127"}}}
	if _, err := ExpandEndpointMembers(endpoints, "root"); err == nil {
		t.Fatal("cached empty list bypassed nesting limit")
	}
}

func TestEndpointReferencesLoadSaveAndAtomicMutation(t *testing.T) {
	keepSettings(t)
	useTempConfig(t)
	raw := "endpoints:\n  outer:\n    ingress: [/v1/messages]\n    failover: [{route: CHILD}]\n  child: [{provider: fixture, model: m, allow_unverified: true}]\n  empty: []\n"
	if err := os.WriteFile(ConfigFilePath(), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
	if err := Save(); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
	if Get().Endpoints["outer"].Failover[0] != (EndpointMember{Route: "CHILD"}) {
		t.Fatal("source reference was flattened or altered")
	}
	payload := configPayload(Get())["endpoints"].(map[string]any)["outer"].(map[string]any)["failover"].([]any)[0].(map[string]any)
	if len(payload) != 1 || payload["route"] != "CHILD" {
		t.Fatalf("bad saved reference: %v", payload)
	}
	encoded, err := json.Marshal(Get().Endpoints["outer"])
	if err != nil {
		t.Fatal(err)
	}
	var decoded EndpointConfig
	if err := json.Unmarshal(encoded, &decoded); err != nil || !reflect.DeepEqual(decoded, *Get().Endpoints["outer"]) {
		t.Fatalf("JSON roundtrip: %v", err)
	}
	for _, mutate := range []func(*Settings){
		func(s *Settings) { delete(s.Endpoints, "child") },
		func(s *Settings) { s.Endpoints["child"].Failover = []EndpointMember{{Route: "outer"}} },
		func(s *Settings) { s.Endpoints["outer"].Failover[0].Provider = "mixed" },
	} {
		before, generation := Snapshot()
		disk, err := os.ReadFile(ConfigFilePath())
		if err != nil {
			t.Fatal(err)
		}
		restore, err := UpdateAndSave(func(s *Settings) error { mutate(s); return nil })
		if err == nil || restore != nil {
			t.Fatal("invalid mutation accepted")
		}
		after, nextGeneration := Snapshot()
		saved, readErr := os.ReadFile(ConfigFilePath())
		if before != after || generation != nextGeneration || readErr != nil || !bytes.Equal(disk, saved) {
			t.Fatal("failed save changed settings, generation or disk")
		}
	}
	previous := Get()
	restore, err := UpdateAndSave(func(s *Settings) error { s.Endpoints["child"].Failover[0].Model = "updated"; return nil })
	if err != nil {
		t.Fatal(err)
	}
	got, err := ExpandEndpointMembers(Get().Endpoints, "outer")
	if err != nil || len(got) != 1 || got[0].Model != "updated" || !got[0].AllowUnverified || previous.Endpoints["child"].Failover[0].Model != "m" {
		t.Fatalf("snapshot clone/reexpansion: %v, %v", got, err)
	}
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
	got, err = ExpandEndpointMembers(Get().Endpoints, "outer")
	if err != nil || got[0].Model != "updated" {
		t.Fatalf("reload: %v, %v", got, err)
	}
	// Load publishes a newer generation, so the existing restore CAS must refuse it.
	if err := restore(); err != ErrRestoreSuperseded {
		t.Fatalf("restore after reload: %v", err)
	}
}

func TestEndpointReferencesInvalidYAMLDoesNotPublish(t *testing.T) {
	for _, member := range []string{
		"{route: missing}", "{route: outer}", "{route: child, provider: ''}",
		"{route: child, model: m}", "{route: child, allow_unverified: false}", "{route: ''}", "{route: 4}",
	} {
		t.Run(member, func(t *testing.T) {
			keepSettings(t)
			useTempConfig(t)
			before, generation := Snapshot()
			raw := "endpoints:\n  outer: [" + member + "]\n  child: []\n"
			if err := os.WriteFile(ConfigFilePath(), []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(); err == nil {
				t.Fatal("invalid reference loaded")
			}
			after, nextGeneration := Snapshot()
			if before != after || generation != nextGeneration {
				t.Fatal("invalid load published")
			}
		})
	}
}
