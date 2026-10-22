package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/iam"
	"llmgw/internal/providers"

	"github.com/kayiik/llm-provider-auth/tokenstore"
	core "github.com/kayiik/llmgw-core"
	"github.com/kayiik/llmgw-core/extension"
	"github.com/kayiik/llmgw-core/oauthflow"
)

func TestDiscoveredExtensionProvidersUseTheirDeclaredTransportAndCredentials(t *testing.T) {
	for _, fixture := range []struct {
		id   string
		kind extension.CredentialKind
	}{
		{"fixture_none", extension.CredentialNone}, {"fixture_token", extension.CredentialToken},
		{"fixture_oauth", extension.CredentialOAuth}, {"anthropic", extension.CredentialNone}, {"Fixture.Mixed", extension.CredentialNone}, {"extension", extension.CredentialNone},
		{"github_copilot", extension.CredentialNone}, {"openai_compatible", extension.CredentialNone},
	} {
		t.Run(fixture.id, func(t *testing.T) {
			kind := fixture.kind
			gateway := useExtensionsAPI(t, true)
			admin := &adminCalls{t: t, server: gateway}
			providerType := fixture.id
			var invokes atomic.Int32
			var streams atomic.Int32
			daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+extensionTestSecret {
					t.Error("extension shared secret was not sent")
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				switch r.URL.Path {
				case extension.PathPrefix + "info":
					writeJSON(w, http.StatusOK, extension.InfoResponse{Version: "0.0.1", Providers: []extension.ProviderInfo{{
						ID: providerType, Name: "Fixture provider", Surfaces: []core.ModelSurface{core.ModelSurfaceResponses},
						Credential: kind, HasOAuth: kind == extension.CredentialOAuth, OAuthMethods: []oauthflow.Method{oauthflow.MethodDevice},
					}}})
				case extension.PathPrefix + providerType + "/models":
					writeJSON(w, http.StatusOK, extension.ModelsResponse{Models: []core.ModelInfo{{ID: "model-a"}}})
				case extension.PathPrefix + providerType + "/invoke":
					invokes.Add(1)
					wantToken := ""
					if kind != extension.CredentialNone {
						wantToken = "fixture-owner-token"
					}
					if r.Header.Get(extension.HeaderCredentialToken) != wantToken || r.Header.Get(extension.HeaderSurface) != string(core.ModelSurfaceResponses) {
						t.Error("the discovered surface or caller credential was not used")
					}
					body, _ := io.ReadAll(r.Body)
					if !strings.Contains(string(body), `"fixture_native":{"number":9007199254740993}`) {
						t.Errorf("native field was changed: %s", body)
					}
					writeJSON(w, http.StatusOK, map[string]any{"id": "fixture-response", "object": "response", "status": "completed", "model": "model-a", "output": []any{}})
				case extension.PathPrefix + providerType + "/stream":
					streams.Add(1)
					if r.Header.Get(extension.HeaderSurface) != string(core.ModelSurfaceResponses) {
						t.Error("stream did not use the declared native API")
					}
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture-stream\",\"object\":\"response\",\"status\":\"completed\",\"output\":[]}}\n\n")
				default:
					http.NotFound(w, r)
				}
			}))
			defer daemon.Close()
			if status, body := admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
				"id": "fixture", "name": "Fixture", "url": daemon.URL, "secret": extensionTestSecret,
			}); status != http.StatusCreated {
				t.Fatalf("extension: %d %+v", status, body)
			}
			if status, _ := admin.call(http.MethodPost, "/admin/api/providers", map[string]any{
				"id": "not-declared", "type": "not_advertised", "extension": "fixture",
			}); status != http.StatusBadRequest {
				t.Fatal("an unadvertised provider was registered")
			}
			if status, body := admin.call(http.MethodPost, "/admin/api/providers", map[string]any{
				"id": "copilot", "type": providerType, "extension": "fixture",
			}); status != http.StatusOK {
				t.Fatalf("discovered provider: %d %+v", status, body)
			}
			key, principal := issueProviderTestKey(t, "fixture-owner", "fixture:generic-extension", "human", "", false)
			if kind == extension.CredentialOAuth {
				if _, err := iam.PutOAuthProviderConnection(iam.OAuthConnectionCreate{
					PrincipalID: principal.PrincipalID, ProviderID: "copilot", Kind: "oauth", Name: "personal", MakeDefault: true,
					AccessToken: "fixture-owner-token", TokenType: "Bearer", Status: "active",
				}); err != nil {
					t.Fatal(err)
				}
			} else if kind == extension.CredentialToken {
				if _, err := iam.PutProviderConnection(iam.ProviderConnectionCreate{
					PrincipalID: principal.PrincipalID, ProviderID: "copilot", Kind: "api_key", Name: "personal", MakeDefault: true, Secret: "fixture-owner-token",
				}); err != nil {
					t.Fatal(err)
				}
			}
			if _, _, err := providers.RefreshCatalogForPrincipalWithError("copilot", callerOf(principal)); err != nil {
				t.Fatal(err)
			}
			if row, found := providers.CatalogCachedLookupForPrincipal("copilot", "model-a", callerOf(principal)); !found || len(row.SupportedSurfaces) != 1 || row.SupportedSurfaces[0] != "/v1/responses" {
				t.Fatalf("discovered provider surfaces were not inherited by its model: %+v", row.SupportedSurfaces)
			}
			status, body := jsonRequest(t, gateway.URL+"/v1/responses", http.MethodPost, key, map[string]any{
				"model": "copilot/model-a", "input": "hello", "fixture_native": map[string]any{"number": json.Number("9007199254740993")},
			})
			if status != http.StatusOK || body["id"] != "fixture-response" || invokes.Load() != 1 {
				t.Fatalf("native invoke: %d %+v calls=%d", status, body, invokes.Load())
			}
			request, _ := http.NewRequest(http.MethodPost, gateway.URL+"/v1/responses", strings.NewReader(`{"model":"copilot/model-a","input":"hello","stream":true}`))
			request.Header.Set("Authorization", "Bearer "+key)
			request.Header.Set("Content-Type", "application/json")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil || response.StatusCode != http.StatusOK || streams.Load() != 1 || !strings.Contains(string(raw), "fixture-stream") {
				t.Fatalf("native stream: status=%d calls=%d err=%v body=%s", response.StatusCode, streams.Load(), err, raw)
			}
			if kind == extension.CredentialOAuth {
				otherKey, other := issueProviderTestKey(t, "fixture-other", "fixture:other-extension-owner", "human", "", false)
				allowed, err := providers.ProviderCredentialAuthorized("copilot", callerOf(other))
				if err != nil || allowed {
					t.Fatalf("another owner was authorized: allowed=%v err=%v", allowed, err)
				}
				status, _ = jsonRequest(t, gateway.URL+"/v1/responses", http.MethodPost, otherKey, map[string]any{"model": "copilot/model-a", "input": "hello"})
				if status == http.StatusOK || invokes.Load() != 1 {
					t.Fatal("another owner reached the extension with a private credential")
				}
			}
			admin.expectNoneCarry(extensionTestSecret)
			admin.expectNoneCarry("fixture-owner-token")
		})
	}
}

func TestDiscoveredExtensionSpeechPreservesTheNativeRequest(t *testing.T) {
	gateway := useExtensionsAPI(t, true)
	admin := &adminCalls{t: t, server: gateway}
	var calls atomic.Int32
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case extension.PathPrefix + "info":
			writeJSON(w, http.StatusOK, extension.InfoResponse{Providers: []extension.ProviderInfo{{ID: "fixture_speech", Name: "Fixture speech", Credential: extension.CredentialNone, Surfaces: []core.ModelSurface{core.ModelSurfaceAudioSpeech}}}})
		case extension.PathPrefix + "fixture_speech/models":
			writeJSON(w, http.StatusOK, extension.ModelsResponse{Models: []core.ModelInfo{{ID: "model-a"}}})
		case extension.PathPrefix + "fixture_speech/invoke":
			calls.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["response_format"] != "wav" || body["voice"] != "fixture-voice" || body["instructions"] != "speak softly" || body["model"] != "model-a" || r.Header.Get(extension.HeaderSurface) != string(core.ModelSurfaceAudioSpeech) {
				t.Errorf("native speech was reduced to a vendor-specific facade: %+v", body)
			}
			w.Header().Set("Content-Type", "audio/wav")
			_, _ = io.WriteString(w, "fixture-wav-bytes")
		default:
			http.NotFound(w, r)
		}
	}))
	defer daemon.Close()
	admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{"id": "fixture", "name": "Fixture", "url": daemon.URL, "secret": extensionTestSecret})
	if status, body := admin.call(http.MethodPost, "/admin/api/providers", map[string]any{"id": "copilot", "type": "fixture_speech", "extension": "fixture"}); status != http.StatusOK {
		t.Fatalf("speech provider: %d %+v", status, body)
	}
	key, principal := issueProviderTestKey(t, "speech-owner", "fixture:speech-owner", "human", "", false)
	if _, _, err := providers.RefreshCatalogForPrincipalWithError("copilot", callerOf(principal)); err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodPost, gateway.URL+"/v1/audio/speech", strings.NewReader(`{"model":"copilot/model-a","input":"hello","voice":"fixture-voice","response_format":"wav","instructions":"speak softly"}`))
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "audio/wav" || string(body) != "fixture-wav-bytes" || calls.Load() != 1 {
		t.Fatalf("speech: status=%d type=%s calls=%d err=%v body=%s", response.StatusCode, response.Header.Get("Content-Type"), calls.Load(), err, body)
	}
}

func TestExtensionOAuthCompletionPreservesPrivateProviderMetadata(t *testing.T) {
	useExtensionsAPI(t, true)
	owner, err := iam.CreatePrincipal("human", "fixture:metadata-owner", "", "Fixture Owner")
	if err != nil {
		t.Fatal(err)
	}
	completion := &oauthCompletion{providerRef: "fixture"}
	_, err = storeOAuthConnection(withOAuthCompletion(context.Background(), completion), oauthflow.Completion{
		Caller: oauthCaller(owner), Instance: "fixture", Method: oauthflow.MethodManual,
		Params: map[string]string{oauthParamKind: "oauth", oauthParamConnectionName: "personal"},
		Record: tokenstore.Record{AccessToken: "fixture-access-token", Expiry: time.Now().Add(time.Hour), Metadata: map[string]string{
			"provider_secret": "fixture-private-metadata", providers.OAuthMetadataProfile: "independent_profile", providers.OAuthMetadataClientID: "fixture-client",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	envelope, _, found, err := iam.OAuthProviderConnectionSecret(owner.ID, "fixture", "personal")
	if err != nil || !found || envelope.Metadata["provider_secret"] != "fixture-private-metadata" || envelope.OAuthProfile != "independent_profile" || envelope.OAuthClientID != "fixture-client" {
		t.Fatal("provider-owned OAuth metadata was lost or replaced by a vendor profile")
	}
	if strings.Contains(string(mustJSON(t, completion.connection)), "fixture-private-metadata") {
		t.Fatal("private provider metadata leaked in connection metadata")
	}
}

func TestDiscoveredExtensionOAuthUsesAdvertisedMethods(t *testing.T) {
	gateway := useExtensionsAPI(t, true)
	admin := &adminCalls{t: t, server: gateway}
	var starts atomic.Int32
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case extension.PathPrefix + "info":
			writeJSON(w, http.StatusOK, extension.InfoResponse{Version: "independent-build", Providers: []extension.ProviderInfo{{
				ID: "fixture_account", Name: "Fixture account", Credential: extension.CredentialOAuth, HasOAuth: true,
				Surfaces: []core.ModelSurface{core.ModelSurfaceChatCompletions}, OAuthMethods: []oauthflow.Method{oauthflow.MethodDevice},
			}}})
		case extension.PathPrefix + "fixture_account/oauth/start":
			starts.Add(1)
			var start extension.OAuthStartRequest
			_ = json.NewDecoder(r.Body).Decode(&start)
			if start.Method != oauthflow.MethodDevice {
				t.Errorf("method=%s", start.Method)
			}
			writeJSON(w, http.StatusOK, extension.OAuthStartResponse{Authorization: oauthflow.Authorization{
				UserCode: "FIXTURE", VerificationURI: "https://auth.example.test/device", Secrets: oauthflow.Secrets{DeviceCode: "fixture-device-code"},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer daemon.Close()
	admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{"id": "fixture", "name": "Fixture", "url": daemon.URL, "secret": extensionTestSecret})
	if status, body := admin.call(http.MethodPost, "/admin/api/providers", map[string]any{"id": "account", "type": "fixture_account", "extension": "fixture"}); status != http.StatusOK {
		t.Fatalf("provider: %d %+v", status, body)
	}
	owner, err := iam.CreatePrincipal("human", "fixture:generic-oauth", "", "Fixture Owner")
	if err != nil {
		t.Fatal(err)
	}
	path := "/admin/api/principals/" + owner.ID + "/connections/account/oauth/start"
	if status, body := admin.call(http.MethodPost, path, map[string]any{"flow": "browser"}); status != http.StatusBadRequest || starts.Load() != 0 {
		t.Fatalf("unadvertised method: %d %+v starts=%d", status, body, starts.Load())
	}
	if status, body := admin.call(http.MethodPost, path, map[string]any{}); status != http.StatusOK || body["flow"] != "device_code" || starts.Load() != 1 {
		t.Fatalf("advertised method: %d %+v starts=%d", status, body, starts.Load())
	}
	_, err = providers.Current().OAuthDriver("fixture_account", "account", oauthflow.MethodBrowser)
	if err == nil {
		t.Fatal("an unadvertised OAuth method built a driver")
	}
}

func TestPublicDiscoveryDoesNotAdvertisePrivateExtensionProviders(t *testing.T) {
	gateway := useExtensionsAPI(t, true)
	status, state := jsonRequest(t, gateway.URL+"/admin/api/state", http.MethodGet, "admin-secret", nil)
	if status != http.StatusOK {
		t.Fatal(status)
	}
	for _, field := range []string{"provider_registry", "provider_types", "provider_statuses"} {
		encoded := string(mustJSON(t, state[field]))
		for _, private := range []string{"github_copilot", "openai_codex", "google_antigravity", "edge_tts", "opencode_zen_anonymous", "anthropic_setup_token"} {
			if strings.Contains(encoded, `"`+private+`"`) {
				t.Errorf("%s advertises %s before discovery", field, private)
			}
		}
	}
}
