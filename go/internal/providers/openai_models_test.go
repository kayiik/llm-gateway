package providers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	core "github.com/kayiik/llmgw-core"
)

func TestOpenRouterCatalogDeclaresChatWithoutInventingOtherCapabilities(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"fixture/free:free","name":"Fixture Free","supported_parameters":["temperature"]}]}`))
	}))
	defer server.Close()

	for _, registry := range []string{"openrouter", "openai"} {
		t.Run(registry, func(t *testing.T) {
			rows, _, err := (openAICatalog{base: server.URL, registryID: registry, timeout: 2}).list(context.Background())
			if err != nil || len(rows) != 1 {
				t.Fatalf("models=%+v err=%v", rows, err)
			}
			caps := AdaptModelCapabilities(rows[0].Capabilities, rows[0].SupportedSurfaces, time.Time{}, time.Time{})
			if registry == "openrouter" {
				if len(rows[0].SupportedSurfaces) != 1 || rows[0].SupportedSurfaces[0] != "/chat/completions" || caps.Operations.Chat != core.SupportSupported {
					t.Fatalf("OpenRouter chat capability missing: model=%+v caps=%+v", rows[0], caps)
				}
			} else if len(rows[0].SupportedSurfaces) != 0 {
				t.Fatalf("generic upstream was given invented surfaces: %+v", rows[0])
			}
			if caps.Tools == core.SupportSupported || caps.Surfaces.Responses == core.SupportSupported || caps.Surfaces.Messages == core.SupportSupported {
				t.Fatalf("unadvertised capabilities were promoted: %+v", caps)
			}
		})
	}
}

func TestOpenAIListModelsPrefersDisplayName(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" || r.Header.Get("Authorization") != "Bearer fixture" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"demo-small","owned_by":"demo","display_name":"Demo Small"}]}`))
	}))
	defer server.Close()

	rows := openAICatalogFixture(server.URL, 2).ListModels()
	if len(rows) != 1 || rows[0].ID != "demo-small" || rows[0].Label != "Demo Small" {
		t.Fatalf("models=%+v", rows)
	}
}

func TestOpenRouterCatalogPreservesAdvertisedCapabilities(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"advertised","supported_parameters":["tools","reasoning","structured_outputs"],"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]},"context_length":128000,"top_provider":{"max_completion_tokens":8192}},{"id":"unknown"},{"id":"explicit-false","capabilities":{"supports":{"tool_calls":false,"vision":false}}}]}`))
	}))
	defer server.Close()
	rows, _, err := (openAICatalog{base: server.URL, registryID: "openrouter", timeout: 2}).list(context.Background())
	if err != nil || len(rows) != 3 {
		t.Fatalf("rows=%+v error=%v", rows, err)
	}
	caps := AdaptModelCapabilities(rows[0].Capabilities, rows[0].SupportedSurfaces, time.Time{}, time.Time{})
	if caps.Tools != core.SupportSupported || caps.Reasoning != core.SupportSupported || caps.StructuredOutput != core.SupportSupported || caps.Inputs.Image != core.SupportSupported || caps.Limits.ContextTokens == nil || *caps.Limits.ContextTokens != 128000 || caps.Limits.MaxOutputTokens == nil || *caps.Limits.MaxOutputTokens != 8192 {
		t.Fatalf("advertised capabilities lost: %+v", caps)
	}
	unknown := AdaptModelCapabilities(rows[1].Capabilities, rows[1].SupportedSurfaces, time.Time{}, time.Time{})
	if unknown.Tools != core.SupportUnknown || unknown.Inputs.Image != core.SupportUnknown || unknown.Limits.ContextTokens != nil {
		t.Fatalf("missing evidence was invented: %+v", unknown)
	}
	unsupported := AdaptModelCapabilities(rows[2].Capabilities, rows[2].SupportedSurfaces, time.Time{}, time.Time{})
	if unsupported.Tools != core.SupportUnsupported || unsupported.Inputs.Image != core.SupportUnsupported {
		t.Fatalf("explicit unsupported evidence lost: %+v", unsupported)
	}
}

// The catalog's failures carry safe codes and details. A credential that
// could not be prepared is reported by the facade that prepares one, as
// Copilot's is; see TestCopilotCatalogStaysOnTheGatewayPath.
func TestOpenAIListModelsReportsSafeFailures(t *testing.T) {
	// Nothing on this path refreshes a key, so a rejection is reported as
	// the catalog answered it. Copilot's catalog replaces a rejected
	// session; see TestCopilotCatalogStaysOnTheGatewayPath.
	t.Run("rejected key", func(t *testing.T) {
		requests := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			requests++
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}))
		defer server.Close()
		_, _, err := listModelsWithError(openAICatalogFixture(server.URL, 2))
		code, _, status := CatalogFailure(err)
		if code != "catalog_http_error" || status != http.StatusUnauthorized || requests != 1 {
			t.Fatalf("failure=(%q,%d) requests=%d", code, status, requests)
		}
	})

	t.Run("http status", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":{"message":"catalog unavailable"}}`, http.StatusBadGateway)
		}))
		defer server.Close()
		_, _, err := listModelsWithError(openAICatalogFixture(server.URL, 2))
		code, detail, status := CatalogFailure(err)
		if code != "catalog_http_error" || status != http.StatusBadGateway ||
			detail == "" {
			t.Fatalf("failure=(%q,%q,%d)", code, detail, status)
		}
	})

	t.Run("invalid json", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("not-json"))
		}))
		defer server.Close()
		_, _, err := listModelsWithError(openAICatalogFixture(server.URL, 2))
		code, _, _ := CatalogFailure(err)
		if code != "catalog_invalid_json" {
			t.Fatalf("code=%q", code)
		}
	})

	t.Run("legitimate empty catalog", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[]}`))
		}))
		defer server.Close()
		models, _, err := listModelsWithError(openAICatalogFixture(server.URL, 2))
		if err != nil || models == nil || len(models) != 0 {
			t.Fatalf("models=%+v err=%v", models, err)
		}
	})
}
