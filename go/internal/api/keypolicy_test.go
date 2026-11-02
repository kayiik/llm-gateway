package api

import (
	"testing"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/router"
)

func TestAuthorizeKeyPolicy_ModelAllowlist(t *testing.T) {
	p := &config.Principal{Token: "k1", AllowedModels: []string{"smart"}}
	_, st, _ := authorizeKeyPolicy(p, "copilot/gpt-4o", "", []router.Target{{Provider: "copilot", Model: "gpt-4o"}})
	if st != 403 {
		t.Fatalf("disallowed model should 403, got %d", st)
	}
	_, st2, _ := authorizeKeyPolicy(p, "smart", "smart", []router.Target{{Provider: "copilot", Model: "x"}})
	if st2 != 0 {
		t.Fatalf("allowed model should pass, got %d", st2)
	}
}

func TestModelPolicyTargetsEquivalentDirectModelIDsAndRouteMembers(t *testing.T) {
	oldEndpoints := config.Get().Endpoints
	t.Cleanup(func() { config.Update(func(s *config.Settings) { s.Endpoints = oldEndpoints }) })
	config.Update(func(s *config.Settings) {
		s.Endpoints = map[string]*config.EndpointConfig{
			"smart": {Failover: []config.EndpointMember{{Provider: "copilot", Model: "gpt-4o"}}},
		}
	})
	targets := []router.Target{{Provider: "copilot", Model: "gpt-4o"}}
	if len(modelPolicyTargets([]string{"copilot/gpt-4o"}, "gpt-4o", "", targets)) != 1 {
		t.Fatal("namespaced allowlist should permit the equivalent bare model")
	}
	if len(modelPolicyTargets([]string{"gpt-4o"}, "copilot/gpt-4o", "", targets)) != 1 {
		t.Fatal("bare allowlist should permit the equivalent namespaced model")
	}
	resolution, err := resolveAs("smart", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(modelPolicyTargets([]string{"copilot/gpt-4o"}, "smart", resolution.Category, resolution.Targets)) != 1 {
		t.Fatal("a model selector should admit its matching route member")
	}
	if len(modelPolicyTargets([]string{"smart"}, "smart", resolution.Category, resolution.Targets)) != 1 {
		t.Fatal("explicit route allowlist should pass")
	}
	resolution, err = resolveAs("SMART", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(modelPolicyTargets([]string{"copilot/gpt-4o"}, "SMART", resolution.Category, resolution.Targets)) != 1 {
		t.Fatal("case-variant request lost its matching route member")
	}
	if len(modelPolicyTargets([]string{"smart"}, "SMART", resolution.Category, resolution.Targets)) != 1 {
		t.Fatal("case-variant route request should match the canonical route allowlist")
	}
	resolution, err = resolveAs(" smart ", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(modelPolicyTargets([]string{"copilot/gpt-4o"}, " smart ", resolution.Category, resolution.Targets)) != 1 {
		t.Fatal("whitespace-variant request lost its matching route member")
	}
	if len(modelPolicyTargets([]string{"smart"}, " smart ", resolution.Category, resolution.Targets)) != 1 {
		t.Fatal("whitespace-variant route request should match the canonical route allowlist")
	}

	config.Update(func(s *config.Settings) {
		s.Endpoints["SMART"] = &config.EndpointConfig{
			Failover: []config.EndpointMember{{Provider: "copilot", Model: "gpt-4.1"}},
		}
	})
	resolution, err = resolveAs("SMART", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(modelPolicyTargets([]string{"smart"}, "SMART", resolution.Category, resolution.Targets)) != 0 {
		t.Fatal("an allowlist for the lower-case route must not authorize a distinct upper-case route")
	}
	if len(modelPolicyTargets([]string{"SMART"}, "SMART", resolution.Category, resolution.Targets)) != 1 {
		t.Fatal("the exact canonical upper-case route should be allowed")
	}
}

func TestAuthorizeKeyPolicy_ProviderFilter(t *testing.T) {
	p := &config.Principal{Token: "k2", AllowedProviders: []string{"localai"}}
	targets := []router.Target{{Provider: "copilot", Model: "a"}, {Provider: "localai", Model: "b"}}
	ft, st, _ := authorizeKeyPolicy(p, "smart", "", targets)
	if st != 0 || len(ft) != 1 || ft[0].Provider != "localai" {
		t.Fatalf("should filter to localai only, got status=%d targets=%v", st, ft)
	}
	p2 := &config.Principal{Token: "k3", AllowedProviders: []string{"nope"}}
	_, st2, _ := authorizeKeyPolicy(p2, "smart", "", targets)
	if st2 != 403 {
		t.Fatalf("no allowed provider in route should 403, got %d", st2)
	}
}

func TestAuthorizeKeyPolicy_LocalUnrestricted(t *testing.T) {
	p := &config.Principal{Token: ""} // admin/local
	targets := []router.Target{{Provider: "copilot", Model: "a"}}
	ft, st, _ := authorizeKeyPolicy(p, "anything", "", targets)
	if st != 0 || len(ft) != 1 {
		t.Fatalf("local principal must be unrestricted, got status=%d", st)
	}
	if st, _, _, _ := admitKeyPolicy(p, time.Now()); st != 0 {
		t.Fatalf("local principal must be unmetered, got status=%d", st)
	}
}
