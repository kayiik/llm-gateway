package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"llmgw/internal/config"
	"llmgw/internal/iam"
)

// deleteProvider asks the administrator API to delete providerID and returns
// the status and the decoded answer.
func deleteProvider(t *testing.T, providerID string) (int, map[string]any) {
	t.Helper()
	request := httptest.NewRequest(http.MethodDelete, "/admin/api/providers/"+providerID, nil)
	request.SetPathValue("id", providerID)
	request.Header.Set("Authorization", "Bearer admin")
	response := httptest.NewRecorder()
	handleDeleteProvider(response, request)
	var answer map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &answer); err != nil {
		t.Fatalf("status=%d body=%s: %v", response.Code, response.Body.String(), err)
	}
	return response.Code, answer
}

// A provider that routes still send requests to, or that people connected
// their own key to, is not deleted, and the refusal names all of it at once:
// every route by name and how many connections, held by how many people,
// still use it, beside the usual error. The console shows that list where
// the provider was removed from, with a way to each place to change it.
func TestDeleteProviderNamesEverythingThatStillUsesIt(t *testing.T) {
	setupAnonymousAutomationAPITest(t)
	config.Update(func(settings *config.Settings) {
		settings.CredentialEncryptionKey = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, 32))
		settings.Providers["fixture"] = &config.ProviderConfig{Type: "echo"}
		settings.Providers["other"] = &config.ProviderConfig{Type: "echo"}
		settings.Endpoints = map[string]*config.EndpointConfig{
			"smart":     {Failover: []config.EndpointMember{{Provider: "other", Model: "echo-default"}, {Provider: "fixture", Model: "echo-default"}}},
			"fast":      {Failover: []config.EndpointMember{{Provider: "fixture", Model: "echo-default"}, {Provider: "fixture", Model: "echo-large"}}},
			"unrelated": {Failover: []config.EndpointMember{{Provider: "other", Model: "echo-default"}}},
		}
	})
	ada, err := iam.CreatePrincipal("human", "fixture:ada", "", "Ada")
	if err != nil {
		t.Fatal(err)
	}
	grace, err := iam.CreatePrincipal("human", "fixture:grace", "", "Grace")
	if err != nil {
		t.Fatal(err)
	}
	for _, connection := range []iam.ProviderConnectionCreate{
		{PrincipalID: ada.ID, ProviderID: "fixture", Name: "personal", Kind: "api_key", Secret: "fixture-ada-personal", MakeDefault: true},
		{PrincipalID: ada.ID, ProviderID: "fixture", Name: "work", Kind: "api_key", Secret: "fixture-ada-work"},
		{PrincipalID: grace.ID, ProviderID: "fixture", Name: "personal", Kind: "api_key", Secret: "fixture-grace", MakeDefault: true},
	} {
		if _, err := iam.PutProviderConnection(connection); err != nil {
			t.Fatal(err)
		}
	}
	// The gateway's own connection goes with the provider, so it keeps
	// nothing.
	if stored, err := iam.PutSystemProviderConnection("fixture", "api_key", "fixture-system"); err != nil || !stored {
		t.Fatalf("system connection: stored=%v err=%v", stored, err)
	}

	status, answer := deleteProvider(t, "fixture")
	if status != http.StatusConflict || config.Get().Providers["fixture"] == nil {
		t.Fatalf("status=%d providers=%+v answer=%+v", status, config.Get().Providers, answer)
	}
	failure, _ := answer["error"].(map[string]any)
	message, _ := failure["message"].(string)
	if failure["code"] != "409" || failure["type"] != "invalid_request_error" ||
		!strings.Contains(message, `"fast"`) || !strings.Contains(message, `"smart"`) || !strings.Contains(message, "connections") {
		t.Fatalf("error=%+v, want the usual envelope naming the routes and the connections", failure)
	}
	if !reflect.DeepEqual(answer["endpoints"], []any{"fast", "smart"}) || answer["connections"] != float64(3) || answer["principals"] != float64(2) {
		t.Fatalf("endpoints=%#v connections=%#v principals=%#v, want fast and smart, 3 connections held by 2 people",
			answer["endpoints"], answer["connections"], answer["principals"])
	}

	// Once the people's connections are revoked, the routes alone keep it.
	connections, err := iam.ListProviderConnections("", "fixture")
	if err != nil {
		t.Fatal(err)
	}
	for _, connection := range connections {
		if connection.PrincipalKind != "system" {
			if err := iam.RevokeProviderConnection(connection.PrincipalID, connection.ID); err != nil {
				t.Fatal(err)
			}
		}
	}
	status, answer = deleteProvider(t, "fixture")
	if status != http.StatusConflict || !reflect.DeepEqual(answer["endpoints"], []any{"fast", "smart"}) ||
		answer["connections"] != float64(0) || answer["principals"] != float64(0) {
		t.Fatalf("routes only: status=%d answer=%+v", status, answer)
	}

	// Without the routes nothing uses it, and it goes.
	config.Update(func(settings *config.Settings) {
		settings.Endpoints = map[string]*config.EndpointConfig{
			"unrelated": {Failover: []config.EndpointMember{{Provider: "other", Model: "echo-default"}}},
		}
	})
	if status, answer = deleteProvider(t, "fixture"); status != http.StatusOK || config.Get().Providers["fixture"] != nil {
		t.Fatalf("unused: status=%d answer=%+v", status, answer)
	}
}

// A provider people still hold connections to, and no route uses, is refused
// with an empty list of routes, so the answer has one shape.
func TestDeleteProviderRefusalListsNoRoutesWhenOnlyConnectionsUseIt(t *testing.T) {
	setupAnonymousAutomationAPITest(t)
	config.Update(func(settings *config.Settings) {
		settings.CredentialEncryptionKey = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, 32))
		settings.Providers["fixture"] = &config.ProviderConfig{Type: "echo"}
	})
	ada, err := iam.CreatePrincipal("human", "fixture:ada", "", "Ada")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iam.PutProviderConnection(iam.ProviderConnectionCreate{
		PrincipalID: ada.ID, ProviderID: "fixture", Kind: "api_key", Secret: "fixture-ada", MakeDefault: true,
	}); err != nil {
		t.Fatal(err)
	}
	status, answer := deleteProvider(t, "fixture")
	if status != http.StatusConflict || !reflect.DeepEqual(answer["endpoints"], []any{}) ||
		answer["connections"] != float64(1) || answer["principals"] != float64(1) {
		t.Fatalf("status=%d answer=%+v", status, answer)
	}
	if strings.Contains(string(mustJSON(t, answer)), "fixture-ada") {
		t.Fatal("the refusal repeats a secret")
	}
}
