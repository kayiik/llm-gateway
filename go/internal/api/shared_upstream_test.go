package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/providers"
)

func startSharedUpstream(t *testing.T, args ...string) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("shared backend/console fixture requires Node.js")
	}
	cmd := exec.Command(node, append([]string{"../../../test/integration/fake-upstream.mjs", "--port=0"}, args...)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			ready <- scanner.Text()
		}
	}()
	var address struct {
		URL string `json:"url"`
	}
	select {
	case line := <-ready:
		if err := json.Unmarshal([]byte(line), &address); err != nil || address.URL == "" {
			t.Fatalf("fixture did not report an address: %q", line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shared fixture did not start")
	}
	return address.URL
}

func TestSharedUpstreamPublicToolConversations(t *testing.T) {
	address := startSharedUpstream(t)
	for _, wire := range []string{"chat", "responses", "messages"} {
		for _, ingress := range []string{"chat", "responses", "messages"} {
			t.Run(ingress+"-to-"+wire, func(t *testing.T) {
				f := newNativePolicyFixture(t)
				f.catalogSurfaces = []string{map[string]string{"chat": "/chat/completions", "responses": "/responses", "messages": "/v1/messages"}[wire]}
				config.Update(func(s *config.Settings) {
					s.APIKey = "gateway-token"
					s.Providers["chat"].RegistryID = "openrouter"
					s.Providers["responses"].ForceApiSupport = true
				})
				if wire != "messages" {
					providers.RefreshCatalog(wire)
				}
				var calls atomic.Int32
				f.inference = sharedConversationInference(t, address, wire, &calls)
				path := map[string]string{"chat": "/v1/chat/completions", "responses": "/v1/responses", "messages": "/v1/messages"}[ingress]
				var answer map[string]any
				for turn := 0; turn < 2; turn++ {
					request := conversationRequest(ingress, wire+"/fixture", answer)
					request["stream"] = true
					if ingress == "chat" {
						request["stream_options"] = map[string]any{"include_usage": true}
					}
					status, raw := cliRequest(t, f.server.URL+path, request, "allow")
					if ingress == "responses" && wire == "messages" {
						if turn != 0 || status != http.StatusBadRequest || calls.Load() != 0 || !bytes.Contains(raw, []byte("request_loss")) || !bytes.Contains(raw, []byte("strict")) {
							t.Fatalf("unsupported strict conversion was not refused before inference: turn=%d status=%d calls=%d body=%s", turn, status, calls.Load(), raw)
						}
						return
					}
					if status != 200 {
						t.Fatalf("turn%d status=%d body=%s", turn, status, raw)
					}
					answer = readConversationStream(t, ingress, raw, turn == 1)
					if turn == 0 {
						assertConversationCall(t, ingress, answer)
					} else {
						assertConversationFinal(t, ingress, answer)
					}
				}
				if calls.Load() != 2 {
					t.Fatalf("actual upstream calls=%d want2", calls.Load())
				}
			})
		}
	}
}

func sharedConversationInference(t *testing.T, address, wire string, calls *atomic.Int32) func(http.ResponseWriter, *http.Request, map[string]any) {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second}
	return func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		if calls.Add(1) == 2 {
			assertConversationToolResult(t, wire, body)
		}
		data, _ := json.Marshal(body)
		request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, address+"/"+wire+r.URL.Path, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		upstream, err := client.Do(request)
		if err != nil {
			t.Errorf("shared fixture: %v", err)
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer upstream.Body.Close()
		w.Header().Set("Content-Type", upstream.Header.Get("Content-Type"))
		w.WriteHeader(upstream.StatusCode)
		_, _ = io.Copy(w, upstream.Body)
	}
}

func TestSharedUpstreamReasoningPreservedOrRefused(t *testing.T) {
	address := startSharedUpstream(t, "--reasoning-annotation")
	for _, ingress := range []string{"chat", "responses", "messages"} {
		t.Run(ingress, func(t *testing.T) {
			f := newNativePolicyFixture(t)
			f.catalogSurfaces = []string{"/chat/completions"}
			config.Update(func(s *config.Settings) {
				s.APIKey = "gateway-token"
				s.Providers["chat"].RegistryID = "openrouter"
			})
			providers.RefreshCatalog("chat")
			var calls atomic.Int32
			f.inference = sharedConversationInference(t, address, "chat", &calls)
			request := conversationRequest(ingress, "chat/fixture", nil)
			request["stream"] = true
			if ingress == "chat" {
				request["stream_options"] = map[string]any{"include_usage": true}
			}
			path := map[string]string{"chat": "/v1/chat/completions", "responses": "/v1/responses", "messages": "/v1/messages"}[ingress]
			status, raw := cliRequest(t, f.server.URL+path, request, "allow")
			if status != http.StatusOK || calls.Load() != 1 {
				t.Fatalf("reasoning stream status=%d calls=%d body=%s", status, calls.Load(), raw)
			}
			if ingress == "chat" {
				if !bytes.Contains(raw, []byte(`"reasoning":"Fixture annotation."`)) || !bytes.Contains(raw, []byte(`"reasoning_details"`)) {
					t.Fatalf("native reasoning changed: %s", raw)
				}
				assertConversationCall(t, ingress, readConversationStream(t, ingress, raw, false))
				return
			}
			failure, success := `"type":"response.failed"`, `"type":"response.completed"`
			if ingress == "messages" {
				failure, success = `"type":"error"`, `"type":"message_stop"`
			}
			if !bytes.Contains(raw, []byte(failure)) || bytes.Contains(raw, []byte(success)) || bytes.Contains(raw, []byte("call_fixture")) {
				t.Fatalf("unassessed reasoning did not fail closed: %s", raw)
			}
		})
	}
}

func TestSharedUpstreamPartialStreamNeverSplicesFallback(t *testing.T) {
	address := startSharedUpstream(t, "--chunk-delay-ms=5", "--disconnect-after=3")
	f := newNativePolicyFixture(t)
	f.catalogSurfaces = []string{"/chat/completions", "/responses"}
	config.Update(func(s *config.Settings) {
		s.APIKey = "gateway-token"
		s.Providers["chat"].RegistryID = "openrouter"
		s.Endpoints["shared-partial"] = &config.EndpointConfig{
			Failover: []config.EndpointMember{{Provider: "chat", Model: "fixture"}, {Provider: "responses", Model: "fixture"}},
			Ingress:  []string{"/v1/chat/completions"}, AllowAdaptation: true,
		}
	})
	providers.RefreshCatalog("chat")
	var first, fallback atomic.Int32
	f.inference = func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		if r.URL.Path != "/chat/completions" {
			fallback.Add(1)
			return
		}
		first.Add(1)
		data, _ := json.Marshal(body)
		request, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, address+"/chat/v1/chat/completions", bytes.NewReader(data))
		upstream, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Errorf("shared partial fixture: %v", err)
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer upstream.Body.Close()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.Copy(sharedFixtureFlushWriter{w}, upstream.Body)
	}
	request := conversationRequest("chat", "shared-partial", nil)
	request["stream"] = true
	status, raw := cliRequest(t, f.server.URL+"/v1/chat/completions", request, "")
	if status != 200 || first.Load() != 1 || fallback.Load() != 0 || !strings.Contains(string(raw), "call_fixture") || strings.Contains(string(raw), "[DONE]") {
		t.Fatalf("status=%d calls=%d/%d body=%s", status, first.Load(), fallback.Load(), raw)
	}
}

type sharedFixtureFlushWriter struct{ http.ResponseWriter }

func (w sharedFixtureFlushWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
	return n, err
}
