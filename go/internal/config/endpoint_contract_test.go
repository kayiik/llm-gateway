package config

import (
	"os"
	"strings"
	"testing"
)

func TestEndpointContractSurvivesLoadAndSave(t *testing.T) {
	keepSettings(t)
	useTempConfig(t)
	raw := "endpoints:\n  coding:\n    ingress: [/v1/chat/completions, /v1/realtime/calls]\n    allow_adaptation: true\n    failover:\n      - {provider: fixture, model: model}\n"
	if err := os.WriteFile(ConfigFilePath(), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
	if err := Save(); err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(ConfigFilePath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(saved), "allow_adaptation: true") || !strings.Contains(string(saved), "/v1/chat/completions") || !strings.Contains(string(saved), "/v1/realtime/calls") {
		t.Fatalf("saved route lost its explicit ingress/adaptation contract:\n%s", saved)
	}
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
	endpoint := configPayload(Get())["endpoints"].(map[string]any)["coding"].(map[string]any)
	if endpoint["allow_adaptation"] != true {
		t.Fatalf("reloaded route has no explicit adaptation permission: %v", endpoint)
	}
}

func TestEndpointContractInvalidInputDoesNotPublish(t *testing.T) {
	for _, contract := range []string{
		"allow_adaptation: true",
		"allow_adaptation: yes\n    ingress: [/v1/chat/completions]",
		"allow_adaptation: true\n    ingress: /v1/chat/completions",
		"allow_adaptation: true\n    ingress: [4]",
		"allow_adaptation: true\n    ingress: [/not-an-api]",
		"allow_adaptation: true\n    ingress: [/v1/chat/completions, /v1/chat/completions]",
	} {
		t.Run(contract, func(t *testing.T) {
			keepSettings(t)
			useTempConfig(t)
			before := Get()
			raw := "endpoints:\n  coding:\n    " + contract + "\n    failover: [{provider: fixture, model: model}]\n"
			if err := os.WriteFile(ConfigFilePath(), []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(); err == nil {
				t.Fatal("invalid route contract was accepted")
			}
			if Get() != before {
				t.Fatal("invalid route contract replaced the published settings")
			}
		})
	}
}
