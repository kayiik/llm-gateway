package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"llmgw/internal/config"
)

type mediaWireRequest struct {
	path string
	body map[string]any
}

func newMediaWireFixture(t *testing.T) (*nativePolicyFixture, <-chan mediaWireRequest) {
	t.Helper()
	fixture := newNativePolicyFixture(t)
	wire := make(chan mediaWireRequest, 16)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		decoder := json.NewDecoder(r.Body)
		decoder.UseNumber()
		if err := decoder.Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		wire <- mediaWireRequest{path: r.URL.Path, body: body}
		stream, _ := body["stream"].(bool)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "GenerateContent"), strings.Contains(r.URL.Path, "generateContent"):
			answer := `{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1,"totalTokenCount":5}}`
			if strings.Contains(r.URL.Path, "streamGenerateContent") {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, "data: "+answer+"\n\n")
			} else {
				_, _ = fmt.Fprint(w, answer)
			}
		case r.URL.Path == "/api/chat":
			_, _ = fmt.Fprintln(w, `{"message":{"content":"ok"},"done":true,"prompt_eval_count":4,"eval_count":1}`)
		case r.URL.Path == "/v1/messages":
			if stream {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, "event: message_start\ndata: "+`{"type":"message_start","message":{"id":"fixture-message","type":"message","role":"assistant","model":"fixture","content":[],"usage":{"input_tokens":4,"output_tokens":0}}}`+"\n\n"+
					"event: content_block_start\ndata: "+`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`+"\n\n"+
					"event: content_block_delta\ndata: "+`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`+"\n\n"+
					"event: content_block_stop\ndata: "+`{"type":"content_block_stop","index":0}`+"\n\n"+
					"event: message_delta\ndata: "+`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`+"\n\n"+
					"event: message_stop\ndata: "+`{"type":"message_stop"}`+"\n\n")
			} else {
				_, _ = fmt.Fprint(w, `{"id":"fixture-message","type":"message","role":"assistant","model":"fixture","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":4,"output_tokens":1}}`)
			}
		case r.URL.Path == "/responses":
			answer := `{"id":"resp_fixture","object":"response","model":"fixture","status":"completed","output":[{"type":"message","id":"msg_fixture","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok","annotations":[]}]}],"usage":{"input_tokens":4,"output_tokens":1,"total_tokens":5}}`
			if stream {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, "event: response.completed\ndata: "+`{"type":"response.completed","sequence_number":0,"response":`+answer+"}\n\n")
			} else {
				_, _ = fmt.Fprint(w, answer)
			}
		case r.URL.Path == "/chat/completions":
			if stream {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, "data: "+`{"id":"fixture-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
			} else {
				_, _ = fmt.Fprint(w, `{"id":"fixture-chat","object":"chat.completion","model":"fixture","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}`)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	config.Update(func(s *config.Settings) {
		for _, provider := range s.Providers {
			provider.BaseURL = upstream.URL
		}
		s.Providers["ollama"] = &config.ProviderConfig{Type: "ollama", BaseURL: upstream.URL}
		s.Providers["bedrock"] = &config.ProviderConfig{Type: "bedrock", BaseURL: upstream.URL, APIKey: "fixture-bedrock"}
	})
	return fixture, wire
}

func callMediaWire(t *testing.T, fixture *nativePolicyFixture, path, model, payload string, stream, adapt bool) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal([]byte(payload), &body); err != nil {
		t.Fatal(err)
	}
	body["model"], body["stream"] = model, stream
	raw, _ := json.Marshal(body)
	request, _ := http.NewRequest(http.MethodPost, fixture.server.URL+path, bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer gateway-fixture")
	if adapt {
		request.Header.Set(compatibilityHeader, "allow")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	result, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK || !strings.Contains(string(result), "ok") {
		t.Fatalf("%s model=%s stream=%t: status=%d err=%v body=%s", path, model, stream, response.StatusCode, err, result)
	}
	return body
}

func TestMultimodalNativeTransport(t *testing.T) {
	fixture, wire := newMediaWireFixture(t)
	for _, tc := range []struct{ path, model, field, body string }{
		{"/v1/chat/completions", "chat/fixture", "messages", `{"messages":[{"role":"user","content":[{"type":"text","text":"before"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AQID","detail":"high"}},{"type":"input_audio","input_audio":{"data":"BAUG","format":"wav"}},{"type":"file","file":{"filename":"fixture.pdf","file_data":"data:application/pdf;base64,BwgJ"}},{"type":"file","file":{"filename":"fixture.mp4","file_data":"data:video/mp4;base64,CgsM"}},{"type":"text","text":"after"}]}]}`},
		{"/v1/chat/completions", "bedrock/fixture", "messages", `{"messages":[{"role":"user","content":[{"type":"text","text":"before"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AQID","detail":"high"}},{"type":"file","file":{"filename":"fixture.pdf","file_data":"data:application/pdf;base64,BAUG"}},{"type":"text","text":"after"}]}]}`},
		{"/v1/responses", "responses/fixture", "input", `{"input":[{"role":"user","content":[{"type":"input_text","text":"before"},{"type":"input_image","image_url":"data:image/png;base64,AQID","detail":"high"},{"type":"input_file","file_url":"https://example.invalid/fixture.pdf"},{"type":"input_text","text":"after"}]}]}`},
		{"/v1/messages", "messages/fixture", "messages", `{"max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"before"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AQID"}},{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"BAUG"},"title":"Fixture","citations":{"enabled":true}},{"type":"text","text":"after"}]}]}`},
	} {
		for _, stream := range []bool{false, true} {
			t.Run(tc.model+tc.path+fmt.Sprint(stream), func(t *testing.T) {
				original := callMediaWire(t, fixture, tc.path, tc.model, tc.body, stream, false)
				got := <-wire
				if !reflect.DeepEqual(got.body[tc.field], original[tc.field]) {
					t.Fatalf("native media changed: %s", jsonStr(got.body))
				}
			})
		}
	}
}

func TestMultimodalAdaptationHTTP(t *testing.T) {
	fixture, wire := newMediaWireFixture(t)
	for _, provider := range []string{"studio", "ollama"} {
		for _, stream := range []bool{false, true} {
			t.Run(provider+fmt.Sprint(stream), func(t *testing.T) {
				body := `{"messages":[{"role":"user","content":[{"type":"text","text":"before"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}},{"type":"text","text":"after"}]}]}`
				if provider == "studio" {
					body = `{"messages":[{"role":"user","content":[{"type":"text","text":"before"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}},{"type":"file","file":{"filename":"fixture.pdf","file_data":"data:application/pdf;base64,BAUG"}},{"type":"input_audio","input_audio":{"data":"BwgJ","format":"mp3"}},{"type":"file","file":{"filename":"fixture.mp4","file_data":"data:video/mp4;base64,CgsM"}},{"type":"text","text":"after"}]}]}`
				}
				callMediaWire(t, fixture, "/v1/chat/completions", provider+"/fixture", body, stream, true)
				got := <-wire
				if provider == "studio" {
					parts := got.body["contents"].([]any)[0].(map[string]any)["parts"].([]any)
					if len(parts) != 6 || !strings.Contains(jsonStr(parts[3]), "audio/mpeg") || !strings.Contains(jsonStr(parts[4]), "video/mp4") {
						t.Fatalf("Google media missing: %s", jsonStr(parts))
					}
				} else {
					message := got.body["messages"].([]any)[0].(map[string]any)
					if message["content"] != "beforeafter" || jsonStr(message["images"]) != `["AQID"]` {
						t.Fatalf("Ollama media missing: %s", jsonStr(message))
					}
				}
			})
		}
	}
}
