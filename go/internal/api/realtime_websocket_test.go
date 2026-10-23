package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
)

const websocketFixtureKey = "dGhlIHNhbXBsZSBub25jZQ=="

func websocketFixtureHeaders() http.Header {
	return http.Header{
		"Authorization": {"Bearer gateway-fixture"}, "Connection": {"keep-alive, Upgrade"}, "Upgrade": {"websocket"},
		"Sec-Websocket-Key": {websocketFixtureKey}, "Sec-Websocket-Version": {"13"},
	}
}

func websocketFixtureConnect(t *testing.T, address, path string, headers http.Header) (net.Conn, *bufio.Reader, *http.Response) {
	t.Helper()
	location, err := url.Parse(address)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.DialTimeout("tcp", location.Host, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	request, _ := http.NewRequest(http.MethodGet, address+path, nil)
	request.Header = headers.Clone()
	if err := request.Write(conn); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		t.Fatal(err)
	}
	return conn, reader, response
}

func websocketFixtureUpgrade(w http.ResponseWriter, r *http.Request) (net.Conn, error) {
	conn, rw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		return nil, err
	}
	_, err = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: %s\r\nSet-Cookie: fixture-private=secret\r\n\r\n", websocketAccept(r.Header.Get("Sec-WebSocket-Key")))
	if err == nil {
		err = rw.Flush()
	}
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	return conn, nil
}

// Fixtures encode frames only; production delegates framing and copying to the
// native peers and net/http rather than maintaining a second WebSocket stack.
func websocketFixtureFrame(opcode byte, payload []byte, masked bool) []byte {
	frame := []byte{0x80 | opcode, 0}
	if len(payload) < 126 {
		frame[1] = byte(len(payload))
	} else {
		frame[1] = 126
		frame = binary.BigEndian.AppendUint16(frame, uint16(len(payload)))
	}
	if !masked {
		return append(frame, payload...)
	}
	frame[1] |= 0x80
	mask := []byte{1, 2, 3, 4}
	frame = append(frame, mask...)
	for index, value := range payload {
		frame = append(frame, value^mask[index%4])
	}
	return frame
}

func websocketFixtureServer(t *testing.T, handler http.Handler) (*httptest.Server, <-chan struct{}) {
	t.Helper()
	done := make(chan struct{}, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
		done <- struct{}{}
	}))
	t.Cleanup(server.Close)
	return server, done
}

func websocketFixtureWait(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("WebSocket handler did not terminate")
	}
}

func TestRealtimeWebsocketNativeFramesAndUnknownUsage(t *testing.T) {
	for _, path := range []string{"/v1/realtime", "/realtime"} {
		t.Run(path, func(t *testing.T) {
			clientFrames := websocketFixtureFrame(1, []byte(`{"type":"session.update","session":{"instructions":"native","provider_number":9007199254740993}}`), true)
			clientFrames = append(clientFrames, websocketFixtureFrame(2, bytes.Repeat([]byte{0, 128, 255}, 1024), true)...)
			serverFrames := websocketFixtureFrame(1, []byte(`{"type":"response.function_call_arguments.done","arguments":"{\"n\":9007199254740993}"}`), false)
			serverFrames = append(serverFrames, websocketFixtureFrame(2, []byte{0, 128, 255, 7}, false)...)
			serverFrames = append(serverFrames, websocketFixtureFrame(9, []byte("ping"), false)...)
			serverFrames = append(serverFrames, websocketFixtureFrame(8, []byte{3, 232}, false)...)
			upstreamResult := make(chan error, 1)
			handler, calls := realtimeFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/realtime" || r.URL.Query().Get("model") != "voice-model" ||
					r.Header.Get("Authorization") != "Bearer fixture-provider-key" || r.Header.Get("OpenAI-Beta") != "realtime=v1" ||
					r.Header.Get("Cookie") != "" || r.Header.Get("X-Api-Key") != "" || r.Header.Get(compatibilityHeader) != "" {
					upstreamResult <- fmt.Errorf("target or credential boundary changed")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				conn, err := websocketFixtureUpgrade(w, r)
				if err != nil {
					upstreamResult <- err
					return
				}
				defer conn.Close()
				actual := make([]byte, len(clientFrames))
				_, err = io.ReadFull(conn, actual)
				if err == nil && !bytes.Equal(actual, clientFrames) {
					err = fmt.Errorf("client native frames changed")
				}
				if err == nil {
					_, err = conn.Write(serverFrames)
				}
				upstreamResult <- err
			}, realtimeWebsocketPath)
			config.Update(func(s *config.Settings) { s.Endpoints["voice"].Ingress = []string{realtimeWebsocketPath} })
			principal, ok := authed(httptest.NewRecorder(), &http.Request{Header: websocketFixtureHeaders()})
			if !ok || len(providers.RefreshCatalogForPrincipal("fixture", callerOf(principal))) != 2 {
				t.Fatal("native WebSocket fixture catalog unavailable")
			}
			server, done := websocketFixtureServer(t, handler)
			headers := websocketFixtureHeaders()
			headers.Set("OpenAI-Beta", "realtime=v1")
			headers.Set("X-Api-Key", "gateway-fixture")
			headers.Set("Cookie", "private=fixture")
			headers.Set(compatibilityHeader, "allow")
			conn, reader, response := websocketFixtureConnect(t, server.URL, path+"?model=voice", headers)
			if response.StatusCode != http.StatusSwitchingProtocols || response.Header.Get("Set-Cookie") != "" || response.Header.Get("X-LLMGW-Usage-Scope") != "unobserved_session" {
				t.Fatalf("invalid upgrade: status=%d headers=%v", response.StatusCode, response.Header)
			}
			if _, err := conn.Write(clientFrames); err != nil {
				t.Fatal(err)
			}
			actual := make([]byte, len(serverFrames))
			if _, err := io.ReadFull(reader, actual); err != nil || !bytes.Equal(actual, serverFrames) {
				t.Fatalf("server native frames changed: %v", err)
			}
			_ = conn.Close()
			websocketFixtureWait(t, done)
			if err := <-upstreamResult; err != nil || calls.Load() != 1 {
				t.Fatalf("relay failed/replayed: err=%v calls=%d", err, calls.Load())
			}
			db, err := iam.DB()
			if err != nil {
				t.Fatal(err)
			}
			var raw string
			var status, input, output int
			if err := db.QueryRow(`SELECT status_code,input_tokens,output_tokens,source_usage_json FROM usage_events WHERE endpoint='openai.realtime.websocket'`).Scan(&status, &input, &output, &raw); err != nil {
				t.Fatal(err)
			}
			var evidence iam.UsageEvidence
			if err := json.Unmarshal([]byte(raw), &evidence); err != nil || status != 101 || input != 0 || output != 0 || !evidence.InputIncomplete || !evidence.OutputIncomplete || evidence.InputBasis != "unobserved_session" || evidence.OutputBasis != "unobserved_session" || !evidence.SelectionUnavailable || evidence.SelectedAttempt != -1 || len(evidence.Attempts) != 1 || len(evidence.Attempts[0].Counts) != 0 {
				t.Fatalf("opaque session fabricated usage: status=%d evidence=%s err=%v", status, raw, err)
			}
		})
	}
}

func TestRealtimeWebsocketLocalRejectionsPrecedeAdmission(t *testing.T) {
	handler, calls := realtimeFixture(t, nil)
	token := admissionFixtureKey(t, "websocket-admission", iam.KeyPolicy{DailyRequests: 1})
	for _, tc := range []struct {
		query string
		alter func(http.Header)
	}{
		{"", nil}, {"?model=voice&model=fixture/other", nil}, {"?model=voice&key=fixture", nil},
		{"?model=voice", func(h http.Header) { h.Del("Upgrade") }},
		{"?model=voice", func(h http.Header) { h.Set("Sec-WebSocket-Key", "invalid") }},
		{"?model=voice", func(h http.Header) { h.Set("Sec-WebSocket-Protocol", "openai-insecure-api-key.fixture") }},
		{"?model=voice", func(h http.Header) { h.Set(transportModeHeader, "transparent") }},
		{"?model=voice", nil}, // Signaling-only ingress cannot grant the WebSocket ingress.
	} {
		request := httptest.NewRequest(http.MethodGet, realtimeWebsocketPath+tc.query, nil)
		request.Header = websocketFixtureHeaders()
		request.Header.Set("Authorization", "Bearer "+token)
		if tc.alter != nil {
			tc.alter(request.Header)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid upgrade accepted: status=%d", response.Code)
		}
	}
	if key, project := consumedRequests(t); key != 0 || project != 0 || calls.Load() != 0 {
		t.Fatalf("local rejection consumed admission: key=%d project=%d calls=%d", key, project, calls.Load())
	}
	config.Update(func(s *config.Settings) { s.Endpoints["voice"].Ingress = []string{realtimeWebsocketPath} })
	principal, ok := authed(httptest.NewRecorder(), &http.Request{Header: websocketFixtureHeaders()})
	if !ok || len(providers.RefreshCatalogForPrincipal("fixture", callerOf(principal))) != 2 {
		t.Fatal("fixture catalog unavailable")
	}
	request := httptest.NewRequest(http.MethodGet, realtimeWebsocketPath+"?model=fixture/voice-model", nil)
	request.Header = websocketFixtureHeaders()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || calls.Load() != 0 {
		t.Fatal("HTTP signaling-only capability became WebSocket support")
	}
}

func TestRealtimeWebsocketRefusalNoReplayAndSingleAdmission(t *testing.T) {
	for _, upstreamStatus := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests, http.StatusTemporaryRedirect} {
		t.Run(fmt.Sprint(upstreamStatus), func(t *testing.T) {
			handler, calls := realtimeFixture(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Retry-After", "7")
				w.Header().Set("Location", "http://fixture-private.invalid/secret")
				w.Header().Set("Set-Cookie", "fixture-secret")
				w.WriteHeader(upstreamStatus)
				_, _ = io.WriteString(w, "fixture-provider-key private error")
			}, realtimeWebsocketPath)
			config.Update(func(s *config.Settings) { s.Endpoints["voice"].Ingress = []string{realtimeWebsocketPath} })
			token := admissionFixtureKey(t, "websocket-refusal", iam.KeyPolicy{DailyRequests: 1})
			server, done := websocketFixtureServer(t, handler)
			headers := websocketFixtureHeaders()
			headers.Set("Authorization", "Bearer "+token)
			conn, _, response := websocketFixtureConnect(t, server.URL, realtimeWebsocketPath+"?model=voice", headers)
			body, _ := io.ReadAll(response.Body)
			_ = response.Body.Close()
			_ = conn.Close()
			websocketFixtureWait(t, done)
			want := upstreamStatus
			if upstreamStatus < 400 {
				want = http.StatusBadGateway
			}
			if response.StatusCode != want || response.Header.Get("Retry-After") != "7" || response.Header.Get("Location") != "" || response.Header.Get("Set-Cookie") != "" || strings.Contains(string(body), "fixture-provider-key") {
				t.Fatalf("refusal escaped or changed: status=%d body=%s", response.StatusCode, body)
			}
			conn, _, response = websocketFixtureConnect(t, server.URL, realtimeWebsocketPath+"?model=voice", headers)
			_ = response.Body.Close()
			_ = conn.Close()
			websocketFixtureWait(t, done)
			if key, project := consumedRequests(t); key != 1 || project != 1 || calls.Load() != 1 || response.StatusCode != http.StatusTooManyRequests {
				t.Fatalf("quota/replay boundary changed: key=%d project=%d calls=%d status=%d", key, project, calls.Load(), response.StatusCode)
			}
		})
	}
}

func TestNativeWebsocketRelayCancellationAndLifetime(t *testing.T) {
	for _, termination := range []string{"cancel", "lifetime", "disconnect"} {
		t.Run(termination, func(t *testing.T) {
			upstreamClosed := make(chan struct{}, 1)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := websocketFixtureUpgrade(w, r)
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
				_, _ = io.Copy(io.Discard, conn)
				upstreamClosed <- struct{}{}
			}))
			defer upstream.Close()
			target, _ := url.Parse(upstream.URL)
			cancel := make(chan context.CancelFunc, 1)
			result := make(chan string, 1)
			server, done := websocketFixtureServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx, stop := context.WithCancel(r.Context())
				defer stop()
				cancel <- stop
				recorder := &statusRecorder{ResponseWriter: w}
				lifetime := time.Minute
				if termination == "lifetime" {
					lifetime = 500 * time.Millisecond
				}
				status, code := relayNativeWebsocket(recorder, r.WithContext(ctx), target, http.Header{}, lifetime)
				if status != 101 || recorder.statusCode() != 101 {
					t.Errorf("upgrade observability incorrect: status=%d recorder=%d", status, recorder.statusCode())
				}
				result <- code
			}))
			conn, reader, response := websocketFixtureConnect(t, server.URL, "/", websocketFixtureHeaders())
			if response.StatusCode != 101 {
				t.Fatalf("relay did not upgrade: %d", response.StatusCode)
			}
			if termination == "cancel" {
				(<-cancel)()
			}
			if termination == "disconnect" {
				_ = conn.Close()
			} else if _, err := reader.ReadByte(); err == nil {
				t.Fatal("cancelled/expired session remained connected")
			}
			_ = conn.Close()
			websocketFixtureWait(t, done)
			websocketFixtureWait(t, upstreamClosed)
			want := "session_deadline"
			if termination == "cancel" {
				want = "client_cancelled"
			} else if termination == "disconnect" {
				want = ""
			}
			if code := <-result; code != want {
				t.Fatalf("termination misclassified: got=%s want=%s", code, want)
			}
		})
	}
}

func TestRealtimeWebsocketRejectsInvalidUpstreamHandshake(t *testing.T) {
	for _, invalidHeader := range []string{"Sec-WebSocket-Accept", "Upgrade", "Sec-WebSocket-Protocol", "Sec-WebSocket-Extensions"} {
		t.Run(invalidHeader, func(t *testing.T) {
			handler, calls := realtimeFixture(t, func(w http.ResponseWriter, r *http.Request) {
				conn, rw, err := http.NewResponseController(w).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
				headers := http.Header{"Connection": {"Upgrade"}, "Upgrade": {"websocket"}, "Sec-Websocket-Accept": {websocketAccept(r.Header.Get("Sec-WebSocket-Key"))}}
				headers.Set(invalidHeader, "fixture-provider-key")
				_, _ = io.WriteString(rw, "HTTP/1.1 101 Switching Protocols\r\n")
				_ = headers.Write(rw)
				_, _ = io.WriteString(rw, "\r\n")
				_ = rw.Flush()
			}, realtimeWebsocketPath)
			server, done := websocketFixtureServer(t, handler)
			conn, _, response := websocketFixtureConnect(t, server.URL, realtimeWebsocketPath+"?model=fixture/voice-model", websocketFixtureHeaders())
			body, _ := io.ReadAll(response.Body)
			_ = response.Body.Close()
			_ = conn.Close()
			websocketFixtureWait(t, done)
			if response.StatusCode != http.StatusBadGateway || calls.Load() != 1 || strings.Contains(string(body), "fixture-provider-key") {
				t.Fatalf("invalid upstream handshake escaped: status=%d calls=%d body=%s", response.StatusCode, calls.Load(), body)
			}
		})
	}
}

func TestRealtimeWebsocketAuthAndProviderScopePrecedeUpstream(t *testing.T) {
	handler, calls := realtimeFixture(t, nil)
	config.Update(func(s *config.Settings) { s.Endpoints["voice"].Ingress = []string{realtimeWebsocketPath} })
	for _, token := range []string{
		"unrecognized-fixture-key",
		admissionFixtureKey(t, "websocket-scope", iam.KeyPolicy{DailyRequests: 1, AllowedProviders: []string{"studio"}}),
		admissionFixtureKey(t, "websocket-route", iam.KeyPolicy{DailyRequests: 1, RoutesOnly: true, AllowedRoutes: []string{"chat-only"}}),
	} {
		request := httptest.NewRequest(http.MethodGet, realtimeWebsocketPath+"?model=voice", nil)
		request.Header = websocketFixtureHeaders()
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code < 400 || calls.Load() != 0 {
			t.Fatalf("unauthorized target reached upstream: status=%d calls=%d", response.Code, calls.Load())
		}
	}
	if key, project := consumedRequests(t); key != 0 || project != 0 {
		t.Fatal("unauthorized upgrade consumed quota")
	}
}
