package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
)

func TestClientSnapshotRespectsKeyAndProjectScope(t *testing.T) {
	owner, project := setupKeyScope(t)
	config.Update(func(s *config.Settings) {
		s.Providers = map[string]*config.ProviderConfig{
			"one": {Type: "openai_compatible", BaseURL: "https://one.example.test/v1", APIKey: "one-secret"},
			"two": {Type: "anthropic", BaseURL: "https://two.example.test", APIKey: "two-secret"},
		}
		s.Endpoints = map[string]*config.EndpointConfig{
			"coding": {AllowAdaptation: true, Ingress: []string{"/v1/chat/completions", "/v1/messages"}, Failover: []config.EndpointMember{
				{Provider: "one", Model: "echo-default"}, {Provider: "two", Model: "echo-default"},
			}},
		}
	})
	providers.ResetProviders()
	catalogModelsForPrincipal = func(providerID string, _ *config.Principal) []providers.ModelInfo {
		surface := "/v1/responses"
		if providerID == "two" {
			surface = "/v1/messages"
		}
		return []providers.ModelInfo{{ID: "echo-default", SupportedSurfaces: []string{surface}}}
	}
	if _, err := iam.SetProjectPolicy(project.ID, iam.KeyPolicy{AllowedProviders: []string{"two"}}); err != nil {
		t.Fatal(err)
	}
	ordinary, err := iam.IssueKey(iam.KeyCreate{ProjectID: project.ID, PrincipalID: owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	offline, err := iam.IssueKey(iam.KeyCreate{ProjectID: project.ID, PrincipalID: owner.ID,
		Policy: iam.KeyPolicy{OfflineAccess: true, RoutesOnly: true, AllowedRoutes: []string{"coding"}}})
	if err != nil {
		t.Fatal(err)
	}
	call := func(token string) (*httptest.ResponseRecorder, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/v1/client-snapshot", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handleClientSnapshot(w, req)
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return w, body
	}
	if w, _ := call(ordinary.Token); w.Code != http.StatusForbidden {
		t.Fatalf("ordinary key exported credentials: %d", w.Code)
	}
	if w, _ := call("scope-admin"); w.Code != http.StatusForbidden {
		t.Fatalf("admin key exported credentials: %d", w.Code)
	}
	w, body := call(offline.Token)
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("snapshot failed: status %d, no-store %t", w.Code, w.Header().Get("Cache-Control") == "no-store")
	}
	selectors := body["selectors"].(map[string]any)
	if len(selectors) != 1 || selectors["coding"] == nil {
		t.Fatalf("route-only key exposed other selectors: %+v", selectors)
	}
	entry := selectors["coding"].(map[string]any)
	if entry["allow_adaptation"] != true || len(entry["targets"].([]any)) != 1 || entry["targets"].([]any)[0] != "two/echo-default" {
		t.Fatalf("project provider policy did not narrow route: %+v", entry)
	}
	if len(entry["ingress"].([]any)) != 2 {
		t.Fatalf("route ingress was not preserved: %+v", entry)
	}
	targets := body["targets"].(map[string]any)
	if len(targets) != 1 || targets["two/echo-default"].(map[string]any)["api_key"] != "two-secret" {
		t.Fatal("wrong scoped target or credential")
	}
	other, err := iam.CreateProject("other-project", "Other project")
	if err != nil {
		t.Fatal(err)
	}
	if err := iam.SetMembership(other.ID, owner.ID, "member"); err != nil {
		t.Fatal(err)
	}
	if _, err := iam.SetProjectPolicy(other.ID, iam.KeyPolicy{AllowedProviders: []string{"one"}}); err != nil {
		t.Fatal(err)
	}
	otherKey, err := iam.IssueKey(iam.KeyCreate{ProjectID: other.ID, PrincipalID: owner.ID,
		Policy: iam.KeyPolicy{OfflineAccess: true, RoutesOnly: true, AllowedRoutes: []string{"coding"}}})
	if err != nil {
		t.Fatal(err)
	}
	_, otherBody := call(otherKey.Token)
	otherTargets := otherBody["targets"].(map[string]any)
	if len(otherTargets) != 1 || otherTargets["one/echo-default"].(map[string]any)["dialect"] != "responses" || otherTargets["one/echo-default"].(map[string]any)["api_key"] != "one-secret" {
		t.Fatal("other project crossed credential scope or lost native Responses")
	}
}

func TestClientSnapshotHTTPProvidesUsableDirectConnection(t *testing.T) {
	owner, project := setupKeyScope(t)
	var upstreamCalls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer direct-fixture-secret" {
			t.Error("direct request did not use the configured path and credential")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "direct-ok"}}}})
	}))
	defer upstream.Close()
	var translatedCalls atomic.Int64
	translated := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		translatedCalls.Add(1)
		var body struct {
			Model     string `json:"model"`
			MaxTokens int    `json:"max_tokens"`
			Stream    bool   `json:"stream"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error("could not decode translated text request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		limit := 1024
		if body.Stream {
			limit = 64
		}
		if r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != "translated-fixture-secret" || body.Model != "fixture" || body.MaxTokens != limit {
			t.Error("SDK did not preserve the approved translated request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if body.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			for _, event := range []string{
				`event: message_start` + "\n" + `data: {"type":"message_start","message":{"id":"msg_direct_fixture","role":"assistant","usage":{"input_tokens":5}}}` + "\n\n",
				`event: content_block_start` + "\n" + `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` + "\n\n",
				`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"direct-"}}` + "\n\n",
				`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}` + "\n\n",
				`event: content_block_stop` + "\n" + `data: {"type":"content_block_stop","index":0}` + "\n\n",
				`event: message_delta` + "\n" + `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}` + "\n\n",
				`event: message_stop` + "\n" + `data: {"type":"message_stop"}` + "\n\n",
			} {
				_, _ = io.WriteString(w, event)
				w.(http.Flusher).Flush()
			}
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"id": "msg_direct_fixture", "type": "message", "role": "assistant", "stop_reason": "end_turn",
			"usage":   map[string]any{"input_tokens": 5, "output_tokens": 2},
			"content": []any{map[string]any{"type": "text", "text": "direct-ok"}},
		})
	}))
	defer translated.Close()
	config.Update(func(s *config.Settings) {
		s.Providers = map[string]*config.ProviderConfig{
			"one": {Type: "openai_compatible", BaseURL: upstream.URL + "/v1", APIKey: "direct-fixture-secret"},
			"two": {Type: "anthropic", BaseURL: translated.URL, APIKey: "translated-fixture-secret"},
		}
		s.Endpoints = map[string]*config.EndpointConfig{"coding": {
			Ingress:         []string{"/v1/chat/completions"},
			AllowAdaptation: true,
			Failover:        []config.EndpointMember{{Provider: "one", Model: "fixture"}, {Provider: "two", Model: "fixture"}},
		}}
	})
	providers.ResetProviders()
	catalogModelsForPrincipal = func(providerID string, _ *config.Principal) []providers.ModelInfo {
		surface := "/v1/chat/completions"
		if providerID == "two" {
			surface = "/v1/messages"
		}
		return []providers.ModelInfo{{ID: "fixture", SupportedSurfaces: []string{surface}}}
	}
	key, err := iam.IssueKey(iam.KeyCreate{ProjectID: project.ID, PrincipalID: owner.ID,
		Policy: iam.KeyPolicy{OfflineAccess: true, RoutesOnly: true, AllowedRoutes: []string{"coding"}}})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(newServer(Runtime{}, time.Now).handler())
	defer server.Close()
	req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/client-snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+key.Token)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("snapshot response: %d", response.StatusCode)
	}
	var snapshot struct {
		Selectors map[string]clientSelector `json:"selectors"`
		Targets   map[string]clientTarget   `json:"targets"`
	}
	if err := json.NewDecoder(response.Body).Decode(&snapshot); err != nil {
		t.Fatal(err)
	}
	ids := snapshot.Selectors["coding"].Targets
	if len(ids) != 2 || ids[0] != "one/fixture" || ids[1] != "two/fixture" || len(snapshot.Targets) != 2 || !snapshot.Selectors["coding"].AllowAdaptation {
		t.Fatalf("unexpected scoped snapshot: %+v", snapshot.Selectors)
	}
	target := snapshot.Targets[ids[0]]
	if target.BaseURL != upstream.URL+"/v1" || target.Dialect != "chat" {
		t.Fatal("wrong direct target address or dialect")
	}
	call, err := http.NewRequest(http.MethodPost, target.BaseURL+"/chat/completions", bytes.NewBufferString(`{"model":"fixture","messages":[{"role":"user","content":"hello"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	call.Header.Set("Authorization", "Bearer "+target.APIKey)
	answer, err := http.DefaultClient.Do(call)
	if err != nil {
		t.Fatal(err)
	}
	defer answer.Body.Close()
	if answer.StatusCode != http.StatusOK {
		t.Fatalf("snapshot credential could not reach target: %d", answer.StatusCode)
	}
	if os.Getenv("LLMGW_SDK_E2E") != "1" {
		return
	}
	root := filepath.Join("..", "..", "..")
	python := `import json,sys;sys.path.insert(0,sys.argv[1]);from llmgw_client import Client;` +
		`c=Client(sys.argv[2],sys.argv[3],sys.argv[4],lambda selector,dialect:['two/fixture']);` +
		`check=lambda events:{'text':''.join(e.data['choices'][0]['delta'].get('content','') for e in events if isinstance(e.data,dict) and e.data.get('choices')),'done':events[-1].data=='[DONE]'};` +
		`print('ok' if sys.argv[5]=='prime' and c.refresh() else json.dumps(check(list(c.stream('chat','coding',{'messages':[{'role':'user','content':'hi'}],'max_tokens':64}))) if sys.argv[5]=='stream' else c.call('chat','coding',{'messages':[{'role':'user','content':'hi'}]})))`
	node := `import {pathToFileURL} from 'node:url';` +
		`const {Client}=await import(pathToFileURL(process.argv[1]).href);` +
		`const c=await new Client({url:process.argv[2],key:process.argv[3],cachePath:process.argv[4],localTargets:()=>['two/fixture']}).load();` +
		`const mode=process.argv[5];if(mode==='prime'){await c.refresh();console.log('ok')}else if(mode==='stream'){` +
		`const s=await c.stream('chat','coding',{messages:[{role:'user',content:'hi'}],max_tokens:64});let text='',done=false;` +
		`for await(const e of s.events){if(e.data==='[DONE]')done=true;else text+=e.data.choices?.[0]?.delta?.content||''}` +
		`console.log(JSON.stringify({text,done}))}else console.log(JSON.stringify(await c.call('chat','coding',{messages:[{role:'user',content:'hi'}]})));`
	type sdkProbe struct {
		command string
		args    []string
	}
	cacheDir := t.TempDir()
	probes := []sdkProbe{
		{"python", []string{"-c", python, filepath.Join(root, "sdk", "python"), server.URL, key.Token, filepath.Join(cacheDir, "python.json")}},
		{"node", []string{"--input-type=module", "-e", node, filepath.Join(root, "sdk", "node", "index.mjs"), server.URL, key.Token, filepath.Join(cacheDir, "node.json")}},
		{"go", []string{"test", "./...", "-run", "^TestConfiguredGatewayE2E$", "-count=1"}},
	}
	probeCommand := func(probe sdkProbe, mode string) *exec.Cmd {
		if probe.command != "go" {
			return exec.Command(probe.command, append(probe.args, mode)...)
		}
		cmd := exec.Command("go", probe.args...)
		cmd.Dir = filepath.Join(root, "sdk", "go")
		cmd.Env = append(os.Environ(),
			"LLMGW_SDK_E2E_URL="+server.URL,
			"LLMGW_SDK_E2E_KEY="+key.Token,
			"LLMGW_SDK_E2E_CACHE="+filepath.Join(cacheDir, "go.json"),
			"LLMGW_SDK_E2E_MODE="+mode,
		)
		return cmd
	}
	for _, probe := range probes {
		if _, err := exec.LookPath(probe.command); err != nil {
			t.Fatalf("SDK end-to-end check requires %s: %v", probe.command, err)
		}
		result, err := probeCommand(probe, "prime").CombinedOutput()
		if err != nil {
			t.Fatalf("%s SDK could not fetch a real gateway snapshot: %v %s", probe.command, err, result)
		}
	}
	server.Close()
	for _, mode := range []string{"call", "stream"} {
		for _, probe := range probes {
			result, err := probeCommand(probe, mode).CombinedOutput()
			if probe.command == "go" {
				if err != nil {
					t.Fatalf("Go SDK could not %s the saved direct target: %v %s", mode, err, result)
				}
				continue
			}
			if mode == "stream" {
				var decoded struct {
					Text string `json:"text"`
					Done bool   `json:"done"`
				}
				decodeErr := json.Unmarshal(result, &decoded)
				if err != nil || decodeErr != nil || decoded.Text != "direct-ok" || !decoded.Done {
					t.Fatalf("%s SDK stream did not complete: %v %s", probe.command, err, result)
				}
				continue
			}
			var decoded struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
			}
			decodeErr := json.Unmarshal(result, &decoded)
			if err != nil || decodeErr != nil || len(decoded.Choices) != 1 || decoded.Choices[0].Message.Content != "direct-ok" {
				t.Fatalf("%s SDK could not call the saved direct target (upstream calls %d): %v %s", probe.command, upstreamCalls.Load(), err, result)
			}
		}
	}
	if translatedCalls.Load() != 6 {
		t.Fatalf("translated fallback reached its target %d times, expected JSON and SSE from each SDK", translatedCalls.Load())
	}
}

func TestOfflineAccessRequiresAdminGrant(t *testing.T) {
	owner, project := setupKeyScope(t)
	create := func(handler http.HandlerFunc, path, token string, payload map[string]any) map[string]any {
		t.Helper()
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("key request: %d %s", w.Code, w.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	admin := create(handleCreateKey, "/admin/api/keys", "scope-admin", map[string]any{
		"project_id": project.ID, "principal_id": owner.ID, "name": "offline", "offline_access": true,
	})
	key, found, err := iam.ResolveAPIKey(admin["token"].(string))
	if err != nil || !found || !key.OfflineAccess {
		t.Fatalf("admin grant was not persisted: %v", err)
	}
	create(handleUpdateKey, "/admin/api/keys/update", "scope-admin", map[string]any{
		"id": key.KeyID, "offline_access": false,
	})
	key, found, err = iam.ResolveAPIKey(admin["token"].(string))
	if err != nil || !found || key.OfflineAccess {
		t.Fatalf("admin revocation was not persisted: %v", err)
	}
}

func TestClientSnapshotOmitsUnsupportedCredentialKinds(t *testing.T) {
	owner, project := setupKeyScope(t)
	config.Update(func(s *config.Settings) {
		s.CredentialEncryptionKey = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
		s.Providers = map[string]*config.ProviderConfig{"one": {
			Type: "openai_compatible", BaseURL: "https://fixture.example.test/v1",
		}}
		s.Endpoints = map[string]*config.EndpointConfig{"coding": {
			Failover: []config.EndpointMember{{Provider: "one", Model: "fixture"}},
		}}
	})
	providers.ResetProviders()
	catalogModelsForPrincipal = func(string, *config.Principal) []providers.ModelInfo {
		return []providers.ModelInfo{{ID: "fixture", SupportedSurfaces: []string{"/v1/chat/completions"}}}
	}
	if _, err := iam.PutProviderConnection(iam.ProviderConnectionCreate{
		PrincipalID: owner.ID, ProviderID: "one", Name: "private", Kind: "token", Secret: "non-api-credential",
	}); err != nil {
		t.Fatal(err)
	}
	key, err := iam.IssueKey(iam.KeyCreate{ProjectID: project.ID, PrincipalID: owner.ID,
		Policy: iam.KeyPolicy{OfflineAccess: true, RoutesOnly: true, AllowedRoutes: []string{"coding"}}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/client-snapshot", nil)
	req.Header.Set("Authorization", "Bearer "+key.Token)
	w := httptest.NewRecorder()
	handleClientSnapshot(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("snapshot rejected: %d", w.Code)
	}
	var snapshot struct {
		Selectors map[string]clientSelector `json:"selectors"`
		Targets   map[string]clientTarget   `json:"targets"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Targets) != 0 || len(snapshot.Selectors) != 0 {
		t.Fatal("unsupported private credential was exported")
	}
}
