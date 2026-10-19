package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func streamingAudioRequest(t *testing.T, endpoint string) (*bytes.Buffer, string) {
	t.Helper()
	if endpoint == "speech" {
		return bytes.NewBufferString(`{"model":"proxy/audio-model","input":"hello","voice":"alloy","stream_format":"sse"}`), "application/json"
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, _ := writer.CreateFormFile("file", "fixture.wav")
	_, _ = file.Write([]byte("fixture audio"))
	for name, values := range map[string][]string{
		"model": {"proxy/audio-model"}, "stream": {"true"}, "response_format": {"json"},
		"include[]": {"logprobs"}, "timestamp_granularities[]": {"word", "segment"},
		"chunking_strategy": {"auto"}, "known_speaker_names[]": {"fixture-a", "fixture-b"},
		"known_speaker_references[]": {"data:audio/wav;base64,AQID", "data:audio/wav;base64,BAUG"},
	} {
		for _, value := range values {
			_ = writer.WriteField(name, value)
		}
	}
	_ = writer.Close()
	return &body, writer.FormDataContentType()
}

func TestAudioProxyStreamsBeforeUpstreamCompletes(t *testing.T) {
	for _, tc := range []struct{ endpoint, contentType, first, last string }{
		{"speech", "audio/mpeg", "ID3\x00\xff", "\x00\x01fixture"},
		{"speech", "text/event-stream; charset=utf-8", "data: {\"type\":\"audio.delta\",", "\"audio\":\"AQID\"}\n\ndata: {\"type\":\"audio.done\"}\n\n"},
		{"transcriptions", "text/event-stream", "data: {\"type\":\"transcript.text.delta\",", "\"delta\":\"hi\"}\n\ndata: {\"type\":\"transcript.text.done\",\"text\":\"hi\"}\n\n"},
	} {
		t.Run(tc.endpoint+"/"+tc.contentType, func(t *testing.T) {
			resetState(t)
			release := make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			defer unblock()
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/v1/audio/"+tc.endpoint {
					t.Errorf("wrong upstream path: %s", r.URL.Path)
				}
				if tc.endpoint == "speech" {
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					format := "sse"
					if strings.HasPrefix(tc.contentType, "audio/") {
						format = "audio"
					}
					if body["model"] != "audio-model" || body["stream_format"] != format {
						t.Errorf("speech controls changed: %v", body)
					}
				} else {
					if err := r.ParseMultipartForm(1 << 20); err != nil {
						t.Error(err)
						return
					}
					if r.FormValue("model") != "audio-model" || r.FormValue("stream") != "true" ||
						!reflect.DeepEqual(r.MultipartForm.Value["timestamp_granularities[]"], []string{"word", "segment"}) ||
						!reflect.DeepEqual(r.MultipartForm.Value["include[]"], []string{"logprobs"}) ||
						!reflect.DeepEqual(r.MultipartForm.Value["known_speaker_names[]"], []string{"fixture-a", "fixture-b"}) ||
						!reflect.DeepEqual(r.MultipartForm.Value["known_speaker_references[]"], []string{"data:audio/wav;base64,AQID", "data:audio/wav;base64,BAUG"}) ||
						r.FormValue("chunking_strategy") != "auto" {
						t.Errorf("transcription controls changed: %v", r.MultipartForm.Value)
					}
				}
				w.Header().Set("Content-Type", tc.contentType)
				_, _ = io.WriteString(w, tc.first)
				w.(http.Flusher).Flush()
				select {
				case <-release:
					_, _ = io.WriteString(w, tc.last)
				case <-r.Context().Done():
				}
			}))
			defer upstream.Close()
			configureProxyProvider(t, upstream.URL)
			completed := make(chan struct{})
			handler := NewServer(Runtime{})
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(completed)
				handler.ServeHTTP(w, r)
			}))
			defer gateway.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			body, contentType := streamingAudioRequest(t, tc.endpoint)
			if strings.HasPrefix(tc.contentType, "audio/") {
				body = bytes.NewBufferString(strings.ReplaceAll(body.String(), `"stream_format":"sse"`, `"stream_format":"audio"`))
			}
			request, _ := http.NewRequestWithContext(ctx, http.MethodPost, gateway.URL+"/v1/audio/"+tc.endpoint, body)
			request.Header.Set("Content-Type", contentType)
			first := make(chan *http.Response, 1)
			failure := make(chan error, 1)
			go func() {
				response, err := http.DefaultClient.Do(request)
				if err == nil {
					first <- response
				} else {
					failure <- err
				}
			}()
			var response *http.Response
			select {
			case response = <-first:
			case err := <-failure:
				unblock()
				t.Fatal(err)
			case <-time.After(2 * time.Second):
				unblock()
				t.Fatal("gateway buffered audio until upstream completion")
			}
			defer response.Body.Close()
			prefix := make([]byte, len(tc.first))
			if _, err := io.ReadFull(response.Body, prefix); err != nil || string(prefix) != tc.first {
				unblock()
				t.Fatalf("first bytes=%q err=%v", prefix, err)
			}
			unblock()
			rest, err := io.ReadAll(response.Body)
			if err != nil || string(rest) != tc.last || response.Header.Get("Content-Type") != tc.contentType || response.StatusCode != http.StatusOK {
				t.Fatalf("stream changed: status=%d type=%s rest=%q err=%v", response.StatusCode, response.Header.Get("Content-Type"), rest, err)
			}
			<-completed
			if count, status, _, code := usageOutcome(t); count != 1 || status != 200 || code != "" || calls.Load() != 1 {
				t.Fatalf("usage count=%d status=%d code=%q calls=%d", count, status, code, calls.Load())
			}
		})
	}
}

func TestAudioProxyStreamCancellationClosesUpstream(t *testing.T) {
	resetState(t)
	closed := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = io.WriteString(w, "ID3")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(closed)
	}))
	defer upstream.Close()
	configureProxyProvider(t, upstream.URL)
	completed := make(chan struct{})
	handler := NewServer(Runtime{})
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(completed)
		handler.ServeHTTP(w, r)
	}))
	defer gateway.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, gateway.URL+"/v1/audio/speech", strings.NewReader(`{"model":"proxy/audio-model","input":"hi"}`))
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	prefix := make([]byte, 3)
	if _, err := io.ReadFull(response.Body, prefix); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled audio request left its upstream open")
	}
	<-completed
	if count, status, _, code := usageOutcome(t); count != 1 || status != 499 || code != "client_cancelled" {
		t.Fatalf("usage count=%d status=%d code=%q", count, status, code)
	}
}

func TestAudioProxyStreamTruncationAbortsDelivery(t *testing.T) {
	resetState(t)
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = io.WriteString(w, "ID3fixture")
		w.(http.Flusher).Flush()
		select {
		case <-release:
			panic(http.ErrAbortHandler)
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	configureProxyProvider(t, upstream.URL)
	completed := make(chan struct{})
	handler := NewServer(Runtime{})
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(completed)
		handler.ServeHTTP(w, r)
	}))
	defer gateway.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, gateway.URL+"/v1/audio/speech", strings.NewReader(`{"model":"proxy/audio-model","input":"hi"}`))
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	prefix := make([]byte, len("ID3fixture"))
	if _, err := io.ReadFull(response.Body, prefix); err != nil {
		t.Fatal(err)
	}
	unblock()
	rest, err := io.ReadAll(response.Body)
	if err == nil || string(prefix) != "ID3fixture" || len(rest) != 0 {
		t.Fatalf("truncation hidden or error appended to audio: %q %q err=%v", prefix, rest, err)
	}
	<-completed
	if count, status, _, code := usageOutcome(t); count != 1 || status != 502 || code != "upstream_body_read" {
		t.Fatalf("usage count=%d status=%d code=%q", count, status, code)
	}
}

func TestAudioStreamingFlagsAreNotIgnoredByBufferedProviders(t *testing.T) {
	for _, endpoint := range []string{"speech", "transcriptions"} {
		t.Run(endpoint, func(t *testing.T) {
			resetState(t)
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprint(w, `{"text":"fixture"}`)
			}))
			defer upstream.Close()
			providerType := "mimo"
			model := "mimo-v2.5-tts"
			if endpoint == "transcriptions" {
				providerType = "elevenlabs"
				model = "scribe_v2"
			}
			configureCoreAudioProvider(t, "proxy", providerType, upstream.URL)
			body, contentType := streamingAudioRequest(t, endpoint)
			body = bytes.NewBufferString(strings.ReplaceAll(body.String(), "proxy/audio-model", "proxy/"+model))
			request := httptest.NewRequest(http.MethodPost, "/v1/audio/"+endpoint, body)
			request.Header.Set("Content-Type", contentType)
			response := httptest.NewRecorder()
			NewServer(Runtime{}).ServeHTTP(response, request)
			message := strings.ToLower(response.Body.String())
			if response.Code != http.StatusBadRequest || calls.Load() != 0 || (!strings.Contains(message, "stream") && !strings.Contains(message, "sse")) {
				t.Fatalf("streaming flag ignored: status=%d calls=%d body=%s", response.Code, calls.Load(), response.Body.String())
			}
		})
	}
}

type countedAudioBody struct {
	io.Reader
	closed int
}

func (body *countedAudioBody) Close() error {
	body.closed++
	return nil
}

func TestAudioProxyStreamWriteAndFlushFailuresCloseBody(t *testing.T) {
	for _, failure := range []string{"write", "flush"} {
		t.Run(failure, func(t *testing.T) {
			body := &countedAudioBody{Reader: strings.NewReader("ID3fixture")}
			writer := &streamTestWriter{}
			if failure == "write" {
				writer.writeErrAt = 1
			} else {
				writer.flushErrAt = 1
			}
			response := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"audio/mpeg"}}, Body: body}
			status, code, abort := writeAudioProxyResponse(writer, httptest.NewRequest(http.MethodPost, "/v1/audio/speech", nil), response, "audio speech")
			if status != 499 || code != "client_cancelled" || !abort || body.closed != 1 {
				t.Fatalf("status=%d code=%q abort=%t closes=%d", status, code, abort, body.closed)
			}
		})
	}
}
