package api

import (
	"bytes"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"

	"llmgw/internal/config"
	"llmgw/internal/providers"
)

func TestPublicHTTPStrictToolsCompatibility(t *testing.T) {
	for _, ingress := range []string{"chat", "responses"} {
		for _, wire := range []string{ingress, "messages"} {
			for _, strict := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s-to-%s/strict=%v", ingress, wire, strict), func(t *testing.T) {
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
					f.inference = func(w http.ResponseWriter, r *http.Request, body map[string]any) {
						calls.Add(1)
						tools, _ := body["tools"].([]any)
						if len(tools) != 1 {
							t.Errorf("tools changed: %+v", body)
							w.WriteHeader(http.StatusInternalServerError)
							return
						}
						tool, _ := tools[0].(map[string]any)
						if wire == "chat" {
							tool, _ = tool["function"].(map[string]any)
						}
						if got, present := tool["strict"]; !present || got != strict {
							t.Errorf("native strict presence/value changed: %+v", body)
						}
						writeJSON(w, http.StatusOK, conversationReply(wire, false))
					}
					body := conversationRequest(ingress, wire+"/fixture", nil)
					tool := body["tools"].([]any)[0].(map[string]any)
					if ingress == "chat" {
						tool = tool["function"].(map[string]any)
					}
					tool["strict"] = strict
					path := map[string]string{"chat": "/v1/chat/completions", "responses": "/v1/responses"}[ingress]
					status, raw := cliRequest(t, f.server.URL+path, body, "allow")
					if wire == "messages" {
						if status != http.StatusBadRequest || calls.Load() != 0 || !bytes.Contains(raw, []byte("request_loss")) || !bytes.Contains(raw, []byte("strict")) {
							t.Fatalf("strict adaptation was not refused before inference: status=%d calls=%d body=%s", status, calls.Load(), raw)
						}
					} else if status != http.StatusOK || calls.Load() != 1 {
						t.Fatalf("native strict request failed: status=%d calls=%d body=%s", status, calls.Load(), raw)
					}
				})
			}
		}
	}
}

func TestPublicHTTPAdaptationRejectsUnassessedReply(t *testing.T) {
	for _, wire := range []string{"chat", "responses", "messages"} {
		for _, ingress := range []string{"chat", "responses", "messages"} {
			if ingress == wire {
				continue
			}
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
				f.inference = func(w http.ResponseWriter, r *http.Request, body map[string]any) {
					calls.Add(1)
					reply := adaptableConversationReply(wire, true)
					reply["vendor_request_id"] = "trace"
					writeJSON(w, http.StatusOK, reply)
				}
				body := conversationRequest(ingress, wire+"/fixture", nil)
				delete(body, "tools")
				path := map[string]string{"chat": "/v1/chat/completions", "responses": "/v1/responses", "messages": "/v1/messages"}[ingress]
				status, raw := cliRequest(t, f.server.URL+path, body, "allow")
				if status != http.StatusBadRequest || calls.Load() != 1 || !bytes.Contains(raw, []byte("response_semantics_unassessed")) {
					t.Fatalf("unassessed reply was not refused: status=%d calls=%d body=%s", status, calls.Load(), raw)
				}
			})
		}
	}
}
