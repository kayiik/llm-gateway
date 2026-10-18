package api

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"

	core "github.com/kayiik/llmgw-core"
	"github.com/kayiik/llmgw-core/extension"
	"github.com/kayiik/llmgw-core/oauthflow"
)

// extensionTestSecret is the shared secret of the daemons these tests serve.
// No response, error, audit record or database file may hold it.
const extensionTestSecret = "fixture-extension-api-secret"

// useExtensionsAPI gives a test its own gateway state, with an administrator
// key, admin-secret, and, when encrypted, a credential encryption key, and
// serves the gateway.
func useExtensionsAPI(t *testing.T, encrypted bool) *httptest.Server {
	t.Helper()
	state := t.TempDir()
	t.Setenv("LLMGW_STATE_DIR", state)
	t.Setenv("LLMGW_CONFIG", filepath.Join(state, "config.yaml"))
	t.Setenv("LLMGW_EXTENSION_URL", "")
	t.Setenv("LLMGW_EXTENSION_SECRET", "")
	iam.ResetForTests()
	old := *config.Get()
	t.Cleanup(func() {
		config.Update(func(s *config.Settings) { *s = old })
		providers.ResetProviders()
		iam.ResetForTests()
	})
	config.Update(func(s *config.Settings) {
		s.APIKey, s.APIKeys, s.AllowUnauthenticatedAPI, s.SSOEnabled = "admin-secret", nil, false, false
		s.CredentialEncryptionKey = ""
		if encrypted {
			s.CredentialEncryptionKey = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{21}, 32))
		}
		s.Providers = map[string]*config.ProviderConfig{}
		s.Endpoints = map[string]*config.EndpointConfig{}
		s.Extensions = nil
	})
	if _, err := iam.Initialize(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(Runtime{}))
	t.Cleanup(server.Close)
	return server
}

// extensionInfo answers the extension protocol's info route as a daemon of
// version that serves GitHub Copilot, and admits only a request that carries
// secret unless the daemon is open.
func extensionInfo(version, secret string, open bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != extension.PathPrefix+"info" {
			http.NotFound(w, r)
			return
		}
		if !open && r.Header.Get("Authorization") != "Bearer "+secret {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		writeJSON(w, http.StatusOK, extension.InfoResponse{Version: version, Providers: []extension.ProviderInfo{
			{ID: "github_copilot", Name: "GitHub Copilot", Surfaces: []core.ModelSurface{core.ModelSurfaceChatCompletions}},
		}})
	}
}

// errorText is the message of an error response.
func errorText(body map[string]any) string {
	failure, _ := body["error"].(map[string]any)
	message, _ := failure["message"].(string)
	return message
}

// adminCalls sends administrator requests to server and keeps every answer,
// so a test can require that none of them carries a secret.
type adminCalls struct {
	t       *testing.T
	server  *httptest.Server
	answers []string
}

func (c *adminCalls) call(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	status, answer := jsonRequest(c.t, c.server.URL+path, method, "admin-secret", body)
	c.answers = append(c.answers, string(mustJSON(c.t, answer)))
	return status, answer
}

func (c *adminCalls) expectNoneCarry(secret string) {
	c.t.Helper()
	for _, answer := range c.answers {
		if strings.Contains(answer, secret) {
			c.t.Fatalf("an answer carries the secret: %s", answer)
		}
	}
}

// An administrator adds, lists, changes and removes extensions. The secret
// is stored encrypted and never shown, the listing says whether each
// extension answers and which providers it serves, and an extension that
// still serves a provider is not removed.
func TestExtensionsAreManagedThroughTheAdminAPI(t *testing.T) {
	server := useExtensionsAPI(t, true)
	admin := &adminCalls{t: t, server: server}
	daemon := httptest.NewServer(extensionInfo("0.0.4", extensionTestSecret, false))
	defer daemon.Close()

	var created map[string]any
	createEvent := expectOneAdminEvent(t, "extension.create", "admin-secret", func() {
		var status int
		status, created = admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
			"name": "Home daemon", "url": daemon.URL + "/", "secret": " " + extensionTestSecret + " ",
		})
		if status != http.StatusCreated {
			t.Fatalf("create: status=%d body=%+v", status, created)
		}
	})
	if created["id"] != "home-daemon" || created["name"] != "Home daemon" || created["url"] != daemon.URL ||
		created["secret_set"] != true || created["created_at"] == nil || created["updated_at"] == nil {
		t.Fatalf("created=%+v", created)
	}
	if served, ok := created["providers"].([]any); !ok || len(served) != 0 {
		t.Fatalf("created providers=%#v, want an empty list", created["providers"])
	}
	if createEvent.TargetType != "extension" || createEvent.TargetID != "home-daemon" {
		t.Fatalf("create event target %s/%s", createEvent.TargetType, createEvent.TargetID)
	}
	expectChanged(t, createEvent, "name", "url", "secret")
	if published := config.Get().Extensions["home-daemon"]; published.URL != daemon.URL || published.Secret != extensionTestSecret {
		t.Fatalf("the running gateway was not given the extension: %s", published.URL)
	}

	// A provider the daemon serves resolves to the only extension.
	if status, body := admin.call(http.MethodPost, "/admin/api/providers", map[string]any{"registry_id": "github_copilot"}); status != http.StatusOK {
		t.Fatalf("provider: status=%d body=%+v", status, body)
	}
	status, listing := admin.call(http.MethodGet, "/admin/api/extensions", nil)
	listed, _ := listing["extensions"].([]any)
	if status != http.StatusOK || len(listed) != 1 || listing["minimum_version"] != "0.0.4" || listing["legacy_environment"] != false {
		t.Fatalf("listing: status=%d body=%+v", status, listing)
	}
	home := listed[0].(map[string]any)
	if !reflect.DeepEqual(home["providers"], []any{map[string]any{"id": "copilot", "type": "github_copilot"}}) {
		t.Fatalf("providers served=%#v", home["providers"])
	}
	checked, _ := home["status"].(map[string]any)
	served, _ := checked["served"].([]any)
	if checked["probed"] != true || checked["reachable"] != true || checked["version"] != "0.0.4" ||
		checked["error_code"] != "" || checked["error"] != "" || checked["unauthenticated"] != false ||
		checked["outdated"] != false || checked["checked_at"] == "" || len(served) != 1 ||
		served[0].(map[string]any)["id"] != "github_copilot" {
		t.Fatalf("status=%+v", checked)
	}
	_, state := admin.call(http.MethodGet, "/admin/api/state", nil)
	if !reflect.DeepEqual(state["provider_extensions"], map[string]any{"copilot": "home-daemon"}) ||
		!reflect.DeepEqual(state["companion_daemon_providers"], []any{"copilot"}) {
		t.Fatalf("state provider_extensions=%#v companion_daemon_providers=%#v", state["provider_extensions"], state["companion_daemon_providers"])
	}

	// An update changes what it carries.
	updateEvent := expectOneAdminEvent(t, "extension.update", "admin-secret", func() {
		status, updated := admin.call(http.MethodPatch, "/admin/api/extensions/home-daemon", map[string]any{"name": "House"})
		if status != http.StatusOK || updated["name"] != "House" || updated["url"] != daemon.URL || updated["id"] != "home-daemon" {
			t.Fatalf("update: status=%d body=%+v", status, updated)
		}
	})
	expectChanged(t, updateEvent, "name")
	for name, test := range map[string]struct {
		path   string
		body   map[string]any
		status int
	}{
		"unknown extension": {"/admin/api/extensions/garage", map[string]any{"name": "Garage"}, http.StatusNotFound},
		"blank name":        {"/admin/api/extensions/home-daemon", map[string]any{"name": " "}, http.StatusBadRequest},
		"unusable address":  {"/admin/api/extensions/home-daemon", map[string]any{"url": "ftp://127.0.0.1:1"}, http.StatusBadRequest},
		"blank secret":      {"/admin/api/extensions/home-daemon", map[string]any{"secret": ""}, http.StatusBadRequest},
	} {
		expectNoNewEvent(t, "extension.update", func() {
			if status, body := admin.call(http.MethodPatch, test.path, test.body); status != test.status || errorText(body) == "" {
				t.Fatalf("%s: status=%d body=%+v, want %d", name, status, body, test.status)
			}
		})
	}

	// What an extension cannot be.
	for name, test := range map[string]struct {
		body   map[string]any
		status int
	}{
		"taken ID":                 {map[string]any{"id": "home-daemon", "name": "Again", "url": daemon.URL, "secret": "fixture-other"}, http.StatusConflict},
		"invalid ID":               {map[string]any{"id": "Home Daemon", "name": "Home", "url": daemon.URL, "secret": "fixture-other"}, http.StatusBadRequest},
		"no name":                  {map[string]any{"name": " ", "url": daemon.URL, "secret": "fixture-other"}, http.StatusBadRequest},
		"address with credentials": {map[string]any{"name": "Home", "url": "http://owner:fixture-url-password@127.0.0.1:1", "secret": "fixture-other"}, http.StatusBadRequest},
		"address with a query":     {map[string]any{"name": "Home", "url": "http://127.0.0.1:1/?token=fixture-query-token", "secret": "fixture-other"}, http.StatusBadRequest},
		"address with a fragment":  {map[string]any{"name": "Home", "url": "http://127.0.0.1:1/#part", "secret": "fixture-other"}, http.StatusBadRequest},
		"address not on the web":   {map[string]any{"name": "Home", "url": "ftp://127.0.0.1:1", "secret": "fixture-other"}, http.StatusBadRequest},
		"relative address":         {map[string]any{"name": "Home", "url": "/extension", "secret": "fixture-other"}, http.StatusBadRequest},
		"no address":               {map[string]any{"name": "Home", "secret": "fixture-other"}, http.StatusBadRequest},
		"no secret":                {map[string]any{"name": "Home", "url": daemon.URL}, http.StatusBadRequest},
	} {
		expectNoNewEvent(t, "extension.create", func() {
			status, body := admin.call(http.MethodPost, "/admin/api/extensions", test.body)
			if status != test.status || errorText(body) == "" ||
				strings.Contains(errorText(body), "fixture-url-password") || strings.Contains(errorText(body), "fixture-query-token") {
				t.Fatalf("%s: status=%d body=%+v, want %d without the address", name, status, body, test.status)
			}
		})
	}
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/admin/api/extensions", strings.NewReader("{not json"))
	request.Header.Set("Authorization", "Bearer admin-secret")
	if response, err := http.DefaultClient.Do(request); err != nil || response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unreadable body: %v %v", response.Status, err)
	} else {
		response.Body.Close()
	}
	if status, _ := jsonRequest(t, server.URL+"/admin/api/extensions", http.MethodGet, "", nil); status != http.StatusUnauthorized {
		t.Fatalf("listing without a key: status=%d, want 401", status)
	}

	// The extension serves copilot, as the only one, so it stays.
	expectNoNewEvent(t, "extension.delete", func() {
		status, refused := admin.call(http.MethodDelete, "/admin/api/extensions/home-daemon", nil)
		if status != http.StatusConflict || !reflect.DeepEqual(refused["providers"], []any{"copilot"}) ||
			!strings.Contains(errorText(refused), "copilot") {
			t.Fatalf("delete of a serving extension: status=%d body=%+v", status, refused)
		}
	})
	if status, body := admin.call(http.MethodDelete, "/admin/api/providers/copilot", nil); status != http.StatusOK {
		t.Fatalf("provider delete: status=%d body=%+v", status, body)
	}
	expectOneAdminEvent(t, "extension.delete", "admin-secret", func() {
		if status, body := admin.call(http.MethodDelete, "/admin/api/extensions/home-daemon", nil); status != http.StatusOK {
			t.Fatalf("delete: status=%d body=%+v", status, body)
		}
	})
	if status, _ := admin.call(http.MethodDelete, "/admin/api/extensions/home-daemon", nil); status != http.StatusNotFound {
		t.Fatalf("second delete: status=%d, want 404", status)
	}
	if _, listing := admin.call(http.MethodGet, "/admin/api/extensions", nil); len(listing["extensions"].([]any)) != 0 || len(config.Get().Extensions) != 0 {
		t.Fatalf("after the delete: listing=%+v published=%d", listing, len(config.Get().Extensions))
	}

	admin.expectNoneCarry(extensionTestSecret)
	expectAuditWithout(t, extensionTestSecret)
	iam.ResetForTests()
	raw, err := os.ReadFile(filepath.Join(config.StateDir(), "gateway.db"))
	if err != nil || bytes.Contains(raw, []byte(extensionTestSecret)) {
		t.Fatalf("gateway.db holds the secret in plaintext (read err %v)", err)
	}
}

// Without the credential encryption key the gateway refuses a secret it
// could only keep in plaintext. An extension whose secret no longer
// decrypts is listed with why it cannot be checked.
func TestExtensionsRefuseASecretWithoutTheEncryptionKey(t *testing.T) {
	server := useExtensionsAPI(t, false)
	admin := &adminCalls{t: t, server: server}
	expectNoNewEvent(t, "extension.create", func() {
		status, body := admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
			"name": "Home", "url": "http://127.0.0.1:18888", "secret": extensionTestSecret,
		})
		if status != http.StatusBadRequest || !strings.Contains(errorText(body), "LLMGW_CREDENTIAL_ENCRYPTION_KEY") {
			t.Fatalf("create without a key: status=%d body=%+v", status, body)
		}
	})
	if _, listing := admin.call(http.MethodGet, "/admin/api/extensions", nil); len(listing["extensions"].([]any)) != 0 || len(config.Get().Extensions) != 0 {
		t.Fatalf("a refused extension was kept: %+v", listing)
	}

	key := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{22}, 32))
	config.Update(func(s *config.Settings) { s.CredentialEncryptionKey = key })
	if status, body := admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
		"id": "home", "name": "Home", "url": "http://127.0.0.1:18888", "secret": extensionTestSecret,
	}); status != http.StatusCreated {
		t.Fatalf("create with a key: status=%d body=%+v", status, body)
	}
	config.Update(func(s *config.Settings) { s.CredentialEncryptionKey = "" })
	if status, body := admin.call(http.MethodPatch, "/admin/api/extensions/home", map[string]any{"secret": "fixture-replacement"}); status != http.StatusBadRequest ||
		!strings.Contains(errorText(body), "LLMGW_CREDENTIAL_ENCRYPTION_KEY") {
		t.Fatalf("secret replaced without a key: status=%d body=%+v", status, body)
	}
	_, listing := admin.call(http.MethodGet, "/admin/api/extensions", nil)
	home := listing["extensions"].([]any)[0].(map[string]any)
	checked := home["status"].(map[string]any)
	if home["secret_set"] != true || checked["probed"] != false || checked["reachable"] != false ||
		checked["error_code"] != "error" || !strings.Contains(fmt.Sprint(checked["error"]), "LLMGW_CREDENTIAL_ENCRYPTION_KEY") {
		t.Fatalf("an extension whose secret does not decrypt: %+v", home)
	}
	admin.expectNoneCarry(extensionTestSecret)
}

// A check asks a daemon what it serves and says what it answered: whether
// it took the secret, whether it is a daemon at all, whether it answered,
// whether it also answers without the secret, and whether it is older than
// the gateway needs. It says so for an address not saved yet and for a
// saved extension alike, and never repeats the secret.
func TestExtensionChecksSayWhatTheDaemonAnswered(t *testing.T) {
	server := useExtensionsAPI(t, true)
	admin := &adminCalls{t: t, server: server}
	var redirectFollowed atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectFollowed.Store(true)
		extensionInfo("0.0.4", extensionTestSecret, false)(w, r)
	}))
	defer target.Close()
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	answer := func(status int, contentType, body string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", contentType)
			w.WriteHeader(status)
			_, _ = io.WriteString(w, strings.ReplaceAll(body, "{authorization}", r.Header.Get("Authorization")))
		}
	}
	type want struct {
		reachable, unauthenticated, outdated bool
		version, code                        string
	}
	for index, test := range []struct {
		name    string
		handler http.HandlerFunc
		address string
		want    want
	}{
		{"protected", extensionInfo("0.0.4", extensionTestSecret, false), "", want{reachable: true, version: "0.0.4"}},
		{"open to anyone", extensionInfo("v0.1.0", "", true), "", want{reachable: true, version: "v0.1.0", unauthenticated: true}},
		{"older than needed", extensionInfo("v0.0.3", extensionTestSecret, false), "", want{reachable: true, version: "v0.0.3", outdated: true}},
		{"a prerelease of the minimum", extensionInfo("0.0.4-rc.1", extensionTestSecret, false), "", want{reachable: true, version: "0.0.4-rc.1", outdated: true}},
		{"a development build", extensionInfo("dev", extensionTestSecret, false), "", want{reachable: true, version: "dev"}},
		{"secret refused", answer(http.StatusUnauthorized, "application/json", `{"error":"unauthorized"}`), "", want{code: "secret_refused"}},
		{"secret forbidden", answer(http.StatusForbidden, "application/json", `{"error":"forbidden"}`), "", want{code: "secret_refused"}},
		{"no such route", answer(http.StatusNotFound, "text/plain", "404 page not found"), "", want{code: "not_an_extension"}},
		{"a web page", answer(http.StatusOK, "text/html", "<html><body>{authorization}</body></html>"), "", want{code: "not_an_extension"}},
		{"another JSON API", answer(http.StatusOK, "application/json", `{"status":"ok"}`), "", want{code: "not_an_extension"}},
		{"failing", answer(http.StatusInternalServerError, "application/json", `{"error":"echo {authorization}"}`), "", want{code: "error"}},
		{"redirecting", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, target.URL+extension.PathPrefix+"info", http.StatusFound)
		}, "", want{code: "error"}},
		{"not answering", nil, closed.URL, want{code: "no_answer"}},
	} {
		address := test.address
		if test.handler != nil {
			daemon := httptest.NewServer(test.handler)
			defer daemon.Close()
			address = daemon.URL
		}
		expect := func(how string, status int, checked map[string]any) {
			t.Helper()
			if status != http.StatusOK || checked["probed"] != true || checked["reachable"] != test.want.reachable ||
				checked["error_code"] != test.want.code || checked["unauthenticated"] != test.want.unauthenticated ||
				checked["outdated"] != test.want.outdated || checked["checked_at"] == "" {
				t.Fatalf("%s, %s: status=%d %+v, want %+v", test.name, how, status, checked, test.want)
			}
			if test.want.reachable && checked["version"] != test.want.version {
				t.Fatalf("%s, %s: version %v, want %q", test.name, how, checked["version"], test.want.version)
			}
			if !test.want.reachable && (fmt.Sprint(checked["error"]) == "" || len(checked["served"].([]any)) != 0) {
				t.Fatalf("%s, %s: a failed check says %+v", test.name, how, checked)
			}
		}
		status, checked := admin.call(http.MethodPost, "/admin/api/extensions/check", map[string]any{"url": address, "secret": extensionTestSecret})
		expect("unsaved", status, checked)
		id := fmt.Sprintf("check-%d", index)
		if status, body := admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
			"id": id, "name": test.name, "url": address, "secret": extensionTestSecret,
		}); status != http.StatusCreated {
			t.Fatalf("%s: create status=%d body=%+v", test.name, status, body)
		}
		status, checked = admin.call(http.MethodPost, "/admin/api/extensions/"+id+"/check", nil)
		expect("saved", status, checked)
	}
	if redirectFollowed.Load() {
		t.Fatal("a check followed a redirect")
	}
	if status, body := admin.call(http.MethodPost, "/admin/api/extensions/check", map[string]any{"url": "http://owner:fixture-url-password@127.0.0.1:1", "secret": "s"}); status != http.StatusBadRequest ||
		strings.Contains(errorText(body), "fixture-url-password") {
		t.Fatalf("check of an unusable address: status=%d body=%+v", status, body)
	}
	if status, _ := admin.call(http.MethodPost, "/admin/api/extensions/check", map[string]any{"url": target.URL}); status != http.StatusBadRequest {
		t.Fatalf("check without a secret: status=%d, want 400", status)
	}
	if status, _ := admin.call(http.MethodPost, "/admin/api/extensions/garage/check", nil); status != http.StatusNotFound {
		t.Fatalf("check of an unknown extension: status=%d, want 404", status)
	}
	admin.expectNoneCarry(extensionTestSecret)
}

// The listing checks every extension at once, so one that is slow to
// answer does not hold up the others' checks: each of these daemons
// answers only once the other has been asked.
func TestTheListingChecksEveryExtensionAtOnce(t *testing.T) {
	server := useExtensionsAPI(t, true)
	admin := &adminCalls{t: t, server: server}
	arrived := map[string]chan struct{}{"home": make(chan struct{}), "office": make(chan struct{})}
	daemon := func(own, other string) *httptest.Server {
		var once sync.Once
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			once.Do(func() { close(arrived[own]) })
			select {
			case <-arrived[other]:
				extensionInfo("0.0.4", extensionTestSecret, false)(w, r)
			case <-time.After(10 * time.Second):
				http.Error(w, "the other daemon was not asked", http.StatusServiceUnavailable)
			}
		}))
	}
	home, office := daemon("home", "office"), daemon("office", "home")
	defer home.Close()
	defer office.Close()
	for id, address := range map[string]string{"home": home.URL, "office": office.URL} {
		if status, body := admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
			"id": id, "name": id, "url": address, "secret": extensionTestSecret,
		}); status != http.StatusCreated {
			t.Fatalf("create %s: status=%d body=%+v", id, status, body)
		}
	}
	// Each daemon answers its authenticated check, after which the open
	// check finds the route closed to it.
	_, listing := admin.call(http.MethodGet, "/admin/api/extensions", nil)
	for _, listed := range listing["extensions"].([]any) {
		entry := listed.(map[string]any)
		if checked := entry["status"].(map[string]any); checked["reachable"] != true {
			t.Fatalf("%s: %+v, want both checked at once", entry["id"], checked)
		}
	}
}

// A request after an administrator moves an extension reaches its new
// address, without a restart.
func TestARequestAfterAnExtensionMovesReachesItsNewAddress(t *testing.T) {
	var oldCalls, newCalls atomic.Int32
	daemon := func(calls *atomic.Int32) *httptest.Server {
		mux := http.NewServeMux()
		mux.HandleFunc("GET /extension/v1/github_copilot/models", func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"models": []any{map[string]any{"id": "model-a", "supported_apis": []string{"/chat/completions"}}}})
		})
		mux.HandleFunc("POST /extension/v1/github_copilot/invoke", func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			writeJSON(w, http.StatusOK, map[string]any{
				"id": "chatcmpl_fixture", "object": "chat.completion", "model": "model-a",
				"choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": "ok"}}},
			})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		return server
	}
	old, moved := daemon(&oldCalls), daemon(&newCalls)
	setupProviderCredentialAPI(t, t.TempDir())
	providers.InstallForTests(t)
	previous := *config.Get()
	t.Cleanup(func() { config.Update(func(s *config.Settings) { *s = previous }) })
	config.Update(func(s *config.Settings) {
		s.Providers = map[string]*config.ProviderConfig{"copilot": {Type: "github_copilot"}}
		s.Endpoints = map[string]*config.EndpointConfig{}
		s.AnthropicDiscoveryAliases = false
		s.Extensions = nil
	})
	providers.ResetProviders()
	t.Cleanup(providers.ResetProviders)
	server := httptest.NewServer(NewServer(Runtime{}))
	defer server.Close()
	admin := &adminCalls{t: t, server: server}
	if status, body := admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
		"id": "daemon", "name": "Daemon", "url": old.URL, "secret": extensionTestSecret,
	}); status != http.StatusCreated {
		t.Fatalf("create: status=%d body=%+v", status, body)
	}
	credential, err := iam.PutGatewayProviderCredential("copilot", "github_oauth", "shared-secret")
	if err != nil {
		t.Fatal(err)
	}
	token, principal := issueProviderTestKey(t, "moving", "service:moving", "service", credential.ID, true)
	if rows := providers.RefreshCatalogForPrincipal("copilot", callerOf(principal)); len(rows) != 1 {
		t.Fatalf("catalog = %+v", rows)
	}
	chat := func() {
		t.Helper()
		status, answer := jsonRequest(t, server.URL+"/v1/chat/completions", http.MethodPost, token, map[string]any{
			"model": "copilot/model-a", "messages": []map[string]any{{"role": "user", "content": "hi"}},
		})
		if status != http.StatusOK {
			t.Fatalf("chat: status=%d answer=%+v", status, answer)
		}
	}
	chat()
	if oldCalls.Load() != 1 || newCalls.Load() != 0 {
		t.Fatalf("before the move: old %d, new %d", oldCalls.Load(), newCalls.Load())
	}
	if status, body := admin.call(http.MethodPatch, "/admin/api/extensions/daemon", map[string]any{"url": moved.URL}); status != http.StatusOK {
		t.Fatalf("move: status=%d body=%+v", status, body)
	}
	chat()
	if oldCalls.Load() != 1 || newCalls.Load() != 1 {
		t.Fatalf("after the move: old %d, new %d, want the request at the new address", oldCalls.Load(), newCalls.Load())
	}
}

// A provider of a type the companion daemon serves names its extension when
// an administrator saves it, the two types only the configuration file
// could configure included.
func TestProvidersNameTheirExtensionWhenSaved(t *testing.T) {
	server := useExtensionsAPI(t, true)
	admin := &adminCalls{t: t, server: server}
	for _, id := range []string{"home", "office"} {
		if status, body := admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
			"id": id, "name": id, "url": "http://127.0.0.1:18888", "secret": extensionTestSecret,
		}); status != http.StatusCreated {
			t.Fatalf("create %s: status=%d body=%+v", id, status, body)
		}
	}
	setupToken := AnthropicSetupTokenPrefix + strings.Repeat("a", 80)
	for _, body := range []map[string]any{
		{"id": "zen", "type": "opencode_zen_anonymous", "extension": "office"},
		{"id": "claude-max", "type": "anthropic_setup_token", "extension": "home", "api_key": setupToken},
		{"registry_id": "github_copilot", "extension": "office"},
	} {
		if status, answer := admin.call(http.MethodPost, "/admin/api/providers", body); status != http.StatusOK {
			t.Fatalf("save %v: status=%d body=%+v", body, status, answer)
		}
	}
	saved := config.Get().Providers
	if saved["zen"].Type != "opencode_zen_anonymous" || saved["zen"].Extension != "office" ||
		saved["claude-max"].Type != "anthropic_setup_token" || saved["claude-max"].Extension != "home" ||
		saved["copilot"].Extension != "office" {
		t.Fatalf("saved zen=%+v claude-max=%+v copilot=%+v", saved["zen"], saved["claude-max"], saved["copilot"])
	}
	if secret, connection, found, err := iam.SystemProviderConnectionSecret("claude-max"); err != nil || !found ||
		connection.Kind != "setup_token" || secret != setupToken {
		t.Fatalf("setup token: found=%v kind=%q err=%v", found, connection.Kind, err)
	}
	_, state := admin.call(http.MethodGet, "/admin/api/state", nil)
	if want := map[string]any{"claude-max": "home", "copilot": "office", "zen": "office"}; !reflect.DeepEqual(state["provider_extensions"], want) {
		t.Fatalf("provider_extensions=%#v, want %#v", state["provider_extensions"], want)
	}
	raw, err := os.ReadFile(config.ConfigFilePath())
	if err != nil || !strings.Contains(string(raw), "extension: office") || !strings.Contains(string(raw), "extension: home") {
		t.Fatalf("the configuration file does not name the extensions (err %v):\n%s", err, raw)
	}

	// A save that leaves the extension out keeps it; an empty one clears it,
	// which leaves the provider to choose between two.
	if status, _ := admin.call(http.MethodPost, "/admin/api/providers", map[string]any{"id": "zen", "type": "opencode_zen_anonymous"}); status != http.StatusOK ||
		config.Get().Providers["zen"].Extension != "office" {
		t.Fatalf("a save without the extension: status=%d zen=%+v", status, config.Get().Providers["zen"])
	}
	cleared := expectOneAdminEvent(t, "provider.update", "admin-secret", func() {
		if status, _ := admin.call(http.MethodPost, "/admin/api/providers", map[string]any{"id": "zen", "type": "opencode_zen_anonymous", "extension": ""}); status != http.StatusOK {
			t.Fatalf("clear: status=%d", status)
		}
	})
	expectChanged(t, cleared, "extension")
	if _, state := admin.call(http.MethodGet, "/admin/api/state", nil); state["provider_extensions"].(map[string]any)["zen"] != "" {
		t.Fatalf("provider_extensions=%#v, want zen without one", state["provider_extensions"])
	}
	for name, body := range map[string]map[string]any{
		"unknown extension":        {"id": "zen", "type": "opencode_zen_anonymous", "extension": "garage"},
		"a provider no daemon has": {"id": "plain", "type": "openai_compatible", "base_url": "http://127.0.0.1:9/v1", "extension": "home"},
	} {
		if status, answer := admin.call(http.MethodPost, "/admin/api/providers", body); status != http.StatusBadRequest || errorText(answer) == "" {
			t.Fatalf("%s: status=%d body=%+v, want 400", name, status, answer)
		}
	}
	if config.Get().Providers["plain"] != nil || config.Get().Providers["zen"].Extension != "" {
		t.Fatalf("a refused save changed the providers: %+v", config.Get().Providers)
	}
	admin.expectNoneCarry(extensionTestSecret)
}

// A provider that names no extension is served by the only one. Adding a
// second would leave it to choose, so before the second is added it is
// pinned to the extension that has been serving it, and it keeps working.
func TestASecondExtensionLeavesProvidersWithTheOneThatServedThem(t *testing.T) {
	server := useExtensionsAPI(t, true)
	admin := &adminCalls{t: t, server: server}
	if status, body := admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
		"id": "home", "name": "Home", "url": "http://127.0.0.1:18888", "secret": extensionTestSecret,
	}); status != http.StatusCreated {
		t.Fatalf("create home: status=%d body=%+v", status, body)
	}
	for _, body := range []map[string]any{
		{"registry_id": "github_copilot"},
		{"id": "zen", "type": "opencode_zen_anonymous"},
	} {
		if status, answer := admin.call(http.MethodPost, "/admin/api/providers", body); status != http.StatusOK {
			t.Fatalf("save %v: status=%d body=%+v", body, status, answer)
		}
	}
	if saved := config.Get().Providers; saved["copilot"].Extension != "" || saved["zen"].Extension != "" {
		t.Fatalf("before the second extension: copilot=%+v zen=%+v, want both naming none", saved["copilot"], saved["zen"])
	}
	created := expectOneAdminEvent(t, "extension.create", "admin-secret", func() {
		if status, body := admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
			"id": "office", "name": "Office", "url": "http://127.0.0.1:18889", "secret": extensionTestSecret,
		}); status != http.StatusCreated {
			t.Fatalf("create office: status=%d body=%+v", status, body)
		}
	})
	if saved := config.Get().Providers; saved["copilot"].Extension != "home" || saved["zen"].Extension != "home" {
		t.Fatalf("after the second extension: copilot=%+v zen=%+v, want both pinned to home", saved["copilot"], saved["zen"])
	}
	if pinned, _ := created.Detail["pinned"].([]any); !reflect.DeepEqual(pinned, []any{"copilot", "zen"}) {
		t.Fatalf("audit detail=%+v, want the pinned providers", created.Detail)
	}
	_, state := admin.call(http.MethodGet, "/admin/api/state", nil)
	if want := map[string]any{"copilot": "home", "zen": "home"}; !reflect.DeepEqual(state["provider_extensions"], want) {
		t.Fatalf("provider_extensions=%#v, want %#v", state["provider_extensions"], want)
	}
	raw, err := os.ReadFile(config.ConfigFilePath())
	if err != nil || strings.Count(string(raw), "extension: home") != 2 {
		t.Fatalf("the configuration file does not pin both providers (err %v):\n%s", err, raw)
	}
	admin.expectNoneCarry(extensionTestSecret)
}

// The sign-in that configures a provider names the extension it runs
// through, which the provider it configures then names. Without one, the
// provider is served by the only extension, and among several it has to
// choose.
func TestASignInStartNamesTheExtensionOfTheProviderItConfigures(t *testing.T) {
	server := useExtensionsAPI(t, true)
	admin := &adminCalls{t: t, server: server}
	starts := make(chan string, 4)
	daemon := func(name string) string {
		mux := http.NewServeMux()
		mux.HandleFunc("POST /extension/v1/github_copilot/oauth/start", func(w http.ResponseWriter, r *http.Request) {
			starts <- name
			writeJSON(w, http.StatusOK, map[string]any{"authorization": oauthflow.Authorization{
				UserCode: "FIXTURE-CODE", VerificationURI: "https://auth.example.test/device",
				Secrets: oauthflow.Secrets{DeviceCode: "fixture-device-" + name},
			}})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		return server.URL
	}
	for _, id := range []string{"home", "office"} {
		if status, body := admin.call(http.MethodPost, "/admin/api/extensions", map[string]any{
			"id": id, "name": id, "url": daemon(id), "secret": extensionTestSecret,
		}); status != http.StatusCreated {
			t.Fatalf("create %s: status=%d body=%+v", id, status, body)
		}
	}
	owner, err := iam.CreatePrincipal("human", "fixture:extension-owner", "", "Extension Owner")
	if err != nil {
		t.Fatal(err)
	}
	route := "/admin/api/principals/" + owner.ID + "/connections/copilot/oauth/start"
	refused := func(body map[string]any, want string) {
		t.Helper()
		if status, answer := admin.call(http.MethodPost, route, body); status != http.StatusBadRequest || !strings.Contains(errorText(answer), want) {
			t.Fatalf("start %v: status=%d body=%+v, want 400 saying %q", body, status, answer, want)
		}
	}
	refused(map[string]any{"flow": "device_code"}, "choose which extension serves it")
	refused(map[string]any{"flow": "device_code", "extension": "garage"}, "garage")
	if config.Get().Providers["copilot"] != nil || len(starts) != 0 {
		t.Fatal("a refused start configured the provider or reached a daemon")
	}
	if status, answer := admin.call(http.MethodPost, route, map[string]any{"flow": "device_code", "extension": "office"}); status != http.StatusOK || answer["device_code"] == nil {
		t.Fatalf("start through office: status=%d body=%+v", status, answer)
	}
	if got := <-starts; got != "office" {
		t.Fatalf("the sign-in started through %s, want office", got)
	}
	if provider := config.Get().Providers["copilot"]; provider == nil || provider.Extension != "office" || provider.Type != "github_copilot" {
		t.Fatalf("configured provider %+v, want it to name office", provider)
	}
	// The provider is configured now, so a start names its extension or none.
	refused(map[string]any{"flow": "device_code", "extension": "home"}, "office")
	if status, _ := admin.call(http.MethodPost, route, map[string]any{"flow": "device_code"}); status != http.StatusOK || <-starts != "office" {
		t.Fatalf("a start naming no extension: status=%d", status)
	}
	admin.expectNoneCarry(extensionTestSecret)
}

// The variables that configured the companion daemon before extensions are
// still reported, by the listing as by the startup warnings.
func TestTheListingSaysWhenTheRetiredVariablesAreSet(t *testing.T) {
	server := useExtensionsAPI(t, true)
	t.Setenv("LLMGW_EXTENSION_SECRET", "fixture-retired-secret")
	status, listing := jsonRequest(t, server.URL+"/admin/api/extensions", http.MethodGet, "admin-secret", nil)
	if status != http.StatusOK || listing["legacy_environment"] != true {
		t.Fatalf("listing: status=%d body=%+v", status, listing)
	}
	if strings.Contains(string(mustJSON(t, listing)), "fixture-retired-secret") {
		t.Fatal("the listing repeats the variable's value")
	}
}

// The single companion daemon's report is gone with the variables it read;
// the extensions listing replaces it.
func TestTheCompanionDaemonReportIsGone(t *testing.T) {
	server := useExtensionsAPI(t, true)
	if status, _ := jsonRequest(t, server.URL+"/admin/api/companion-daemon", http.MethodGet, "admin-secret", nil); status != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", status)
	}
}

// A version is outdated when it is a semantic version below the minimum the
// gateway needs; one that is not, such as a development build, is not.
func TestExtensionVersionsBelowTheMinimumAreOutdated(t *testing.T) {
	for version, outdated := range map[string]bool{
		"0.0.3": true, "v0.0.3": true, "0.0.3+build.5": true, "0.0.4-rc.1": true, "0.0.4-alpha": true,
		"0.0.4": false, "v0.0.4": false, "0.0.4+build.5": false, "0.0.10": false, "0.1.0": false, "1.0.0": false,
		"dev": false, "": false, "0.0": false, "0.0.x": false, "00.0.3": false, "0.0.3-": false, "V0.0.3": false,
	} {
		if got := extensionOutdated(version); got != outdated {
			t.Errorf("version %q outdated=%v, want %v", version, got, outdated)
		}
	}
}
