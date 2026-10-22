package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/config"

	"github.com/kayiik/llmgw-core/realtimews"
)

const geminiSessionFixture = `{"type":"session.update","session":{"type":"realtime","audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"turn_detection":null},"output":{"format":{"type":"audio/pcm","rate":24000},"voice":"Puck"}},"output_modalities":["audio"],"tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{"count":{"type":"integer"}},"required":["count"]}}]}}`

func geminiClientEvent(t *testing.T, conn *realtimews.Conn, kind string) map[string]any {
	t.Helper()
	for i := 0; i < 30; i++ {
		raw, err := conn.Read()
		if err != nil {
			t.Fatalf("waiting for %s: %v", kind, err)
		}
		var event map[string]any
		if json.Unmarshal(raw, &event) != nil {
			t.Fatal("invalid client event")
		}
		if event["type"] == kind {
			return event
		}
		if event["type"] == "error" {
			t.Fatalf("unexpected protocol error: %s", raw)
		}
	}
	t.Fatalf("missing event %s", kind)
	return nil
}

func geminiWrite(t *testing.T, conn *realtimews.Conn, raw string) {
	t.Helper()
	if err := conn.Write([]byte(raw)); err != nil {
		t.Fatal(err)
	}
}

func geminiGatewayFixture(t *testing.T, upstream *httptest.Server) http.Handler {
	t.Helper()
	handler, _ := realtimeFixture(t, nil)
	config.Update(func(s *config.Settings) {
		s.Providers["studio"].BaseURL = upstream.URL + "/v1beta"
		s.Endpoints["voice"].Ingress = []string{realtimeWebsocketPath}
		s.Endpoints["voice"].AllowAdaptation = true
		s.Endpoints["voice"].Failover = []config.EndpointMember{{Provider: "studio", Model: "fixture-live"}}
	})
	return handler
}

func TestGeminiRealtimeVoiceAndToolRoundtrip(t *testing.T) {
	// Deterministic PCM framing, not a claim that a mock generates or understands
	// speech. The format is decodable mono little-endian PCM16 at declared rates.
	input := bytes.Repeat([]byte{0x10, 0x01, 0xf0, 0xfe}, 1200)
	output := bytes.Repeat([]byte{0x20, 0x01, 0xe0, 0xfe}, 1200)
	output64 := base64.StdEncoding.EncodeToString(output)
	var connections, inputTurns, toolResults, interruptions, activityStarts atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" || r.Header.Get("x-goog-api-key") != "fixture-provider-key" || r.Header.Get("Authorization") != "" || r.URL.RawQuery != "" {
			t.Error("wrong Live URL or caller/provider credential separation")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		conn, err := realtimews.Upgrade(w, r)
		if err != nil {
			return
		}
		connections.Add(1)
		defer conn.Close()
		writeAudio := func(complete bool) {
			_ = conn.Write([]byte(`{"serverContent":{"modelTurn":{"role":"model","parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"` + output64 + `"}}]},"outputTranscription":{"text":"fixture spoken answer"}}}`))
			if complete {
				_ = conn.Write([]byte(`{"serverContent":{"generationComplete":true}}`))
				_ = conn.Write([]byte(`{"serverContent":{"turnComplete":true}}`))
			}
		}
		var receivedInput []byte
		for {
			raw, err := conn.Read()
			if err != nil {
				return
			}
			var event map[string]json.RawMessage
			_ = json.Unmarshal(raw, &event)
			if setup := event["setup"]; setup != nil {
				if !bytes.Contains(setup, []byte(`"models/fixture-live"`)) || !bytes.Contains(setup, []byte(`"voiceName":"Puck"`)) {
					t.Error("frozen target or explicit voice changed")
				}
				_ = conn.Write([]byte(`{"setupComplete":{}}`))
			}
			if audio := event["realtimeInput"]; audio != nil {
				var in struct {
					Audio         *struct{ Data, MimeType string }
					ActivityEnd   *struct{}
					ActivityStart *struct{}
				}
				_ = json.Unmarshal(audio, &in)
				if in.ActivityStart != nil {
					activityStarts.Add(1)
					if inputTurns.Load() == 2 && interruptions.Add(1) == 1 {
						// Queued output from the interrupted turn must not leak into
						// playback after cancellation or the next response.
						writeAudio(false)
						_ = conn.Write([]byte(`{"serverContent":{"interrupted":true}}`))
						_ = conn.Write([]byte(`{"serverContent":{"turnComplete":true}}`))
					}
				}
				if in.Audio != nil {
					decoded, err := base64.StdEncoding.DecodeString(in.Audio.Data)
					if err != nil || len(decoded)%2 != 0 || in.Audio.MimeType != "audio/pcm;rate=24000" {
						t.Error("input PCM framing or declared clock changed")
					}
					receivedInput = append(receivedInput, decoded...)
				}
				if in.ActivityEnd != nil {
					if !bytes.Equal(receivedInput, input) || len(receivedInput)/2 != 2400 || time.Duration(len(receivedInput)/2)*time.Second/24000 != 100*time.Millisecond {
						t.Error("chunked PCM bytes, sample count or duration changed")
					}
					receivedInput = nil
					switch inputTurns.Add(1) {
					case 1:
						writeAudio(true)
					case 2:
						writeAudio(false)
					default:
						_ = conn.Write([]byte(`{"toolCall":{"functionCalls":[{"id":"fixture-call","name":"lookup","args":{"count":9007199254740993}}]}}`))
					}
				}
			}
			if results := event["toolResponse"]; results != nil {
				if !bytes.Contains(results, []byte(`"id":"fixture-call"`)) || !bytes.Contains(results, []byte(`"output":"fixture-result"`)) {
					t.Error("tool result identity or value changed")
				}
				toolResults.Add(1)
				writeAudio(true)
			}
		}
	}))
	defer upstream.Close()
	server := httptest.NewServer(geminiGatewayFixture(t, upstream))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := realtimews.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/v1/realtime?model=voice", http.Header{"Authorization": {"Bearer gateway-fixture"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	geminiClientEvent(t, client, "session.created")
	geminiWrite(t, client, geminiSessionFixture)
	geminiClientEvent(t, client, "session.updated")
	turn := func() {
		for _, chunk := range [][]byte{input[:2], input[2:14], input[14:]} {
			geminiWrite(t, client, `{"type":"input_audio_buffer.append","audio":"`+base64.StdEncoding.EncodeToString(chunk)+`"}`)
		}
		geminiWrite(t, client, `{"type":"input_audio_buffer.commit"}`)
		geminiWrite(t, client, `{"type":"response.create"}`)
	}
	readAudio := func() {
		event := geminiClientEvent(t, client, "response.output_audio.delta")
		data, err := base64.StdEncoding.DecodeString(event["delta"].(string))
		if err != nil || !bytes.Equal(data, output) || len(data)%2 != 0 {
			t.Fatal("output PCM cannot be decoded losslessly")
		}
	}
	turn()
	readAudio()
	geminiClientEvent(t, client, "response.done")
	turn()
	readAudio()
	geminiWrite(t, client, `{"type":"response.cancel"}`)
	for {
		raw, err := client.Read()
		if err != nil {
			t.Fatal(err)
		}
		var event map[string]any
		_ = json.Unmarshal(raw, &event)
		if event["type"] == "response.output_audio.delta" || event["type"] == "error" {
			t.Fatal("late cancelled output escaped or valid cancellation was refused")
		}
		if event["type"] == "response.done" {
			if event["response"].(map[string]any)["status"] != "cancelled" || interruptions.Load() != 1 {
				t.Fatal("cancellation acknowledged without native interruption")
			}
			break
		}
	}
	turn()
	call := geminiClientEvent(t, client, "response.function_call_arguments.done")
	if call["call_id"] != "fixture-call" || call["arguments"] != `{"count":9007199254740993}` {
		t.Fatal("tool arguments or call correlation changed")
	}
	geminiClientEvent(t, client, "response.done")
	geminiWrite(t, client, `{"type":"conversation.item.create","item":{"type":"function_call_output","call_id":"fixture-call","output":"fixture-result"}}`)
	geminiWrite(t, client, `{"type":"response.create"}`)
	readAudio()
	geminiClientEvent(t, client, "response.done")
	if connections.Load() != 1 || inputTurns.Load() != 3 || toolResults.Load() != 1 || activityStarts.Load() != 3 {
		t.Fatalf("hidden reconnect, duplicate generation or tool result: connections=%d turns=%d results=%d starts=%d", connections.Load(), inputTurns.Load(), toolResults.Load(), activityStarts.Load())
	}
	geminiWrite(t, client, `{"type":"conversation.item.truncate","item_id":"fixture-item","content_index":0,"audio_end_ms":20}`)
	geminiClientEvent(t, client, "error")
	if _, err := client.Read(); err == nil {
		t.Fatal("unsafe heard-history continuation stayed open after fatal refusal")
	}
}

func TestGeminiRealtimeRouteDoesNotBroadenAdaptation(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer upstream.Close()
	handler := geminiGatewayFixture(t, upstream)
	config.Update(func(s *config.Settings) { s.Endpoints["voice"].AllowAdaptation = false })
	server := httptest.NewServer(handler)
	defer server.Close()
	for _, compatibility := range []string{"", "allow"} {
		headers := websocketFixtureHeaders()
		if compatibility != "" {
			headers.Set("X-LLMGW-Compatibility", compatibility)
		}
		conn, _, response := websocketFixtureConnect(t, server.URL, "/v1/realtime?model=voice", headers)
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		_ = conn.Close()
		if response.StatusCode != http.StatusBadRequest || calls.Load() != 0 {
			t.Fatal("request broadened route adaptation or contacted upstream before admission")
		}
	}
}

func TestGeminiRealtimeBridgeCancellation(t *testing.T) {
	upstreamClosed := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := realtimews.Upgrade(w, r)
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = conn.Read()
		upstreamClosed <- struct{}{}
	}))
	defer upstream.Close()
	stop := make(chan context.CancelFunc, 1)
	result := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		remote, err := realtimews.Dial(ctx, "ws"+strings.TrimPrefix(upstream.URL, "http"), nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer remote.Close()
		client, err := realtimews.Upgrade(w, r.WithContext(ctx))
		if err != nil {
			return
		}
		defer client.Close()
		stop <- cancel
		result <- bridgeGeminiRealtime(ctx, client, remote, "fixture-live")
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := realtimews.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	geminiClientEvent(t, client, "session.created")
	(<-stop)()
	if _, err := client.Read(); err == nil {
		t.Fatal("cancelled bridge left its client open")
	}
	select {
	case code := <-result:
		if code != "session_cancelled" {
			t.Fatalf("cancellation/read race misclassified: %s", code)
		}
	case <-ctx.Done():
		t.Fatal("cancelled bridge did not return")
	}
	select {
	case <-upstreamClosed:
	case <-ctx.Done():
		t.Fatal("cancelled bridge left its upstream open")
	}
}

func TestGeminiRealtimeHandshakeDeclaresLimitedProfile(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := realtimews.Upgrade(w, r)
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = conn.Read()
	}))
	defer upstream.Close()
	handler := geminiGatewayFixture(t, upstream)
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	conn, _, response := websocketFixtureConnect(t, server.URL, "/v1/realtime?model=voice", websocketFixtureHeaders())
	defer conn.Close()
	if response.StatusCode != http.StatusSwitchingProtocols || response.Header.Get("X-LLMGW-Usage-Scope") != "unobserved_session" || response.Header.Get("X-LLMGW-Realtime-Profile") != "openai-ga-gemini-live-manual-pcm" {
		t.Fatalf("limited-profile handshake headers missing: status=%d headers=%v", response.StatusCode, response.Header)
	}
	_ = conn.Close()
	websocketFixtureWait(t, done)
}
