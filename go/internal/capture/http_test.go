package capture

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func records(t *testing.T, dir string) []Record {
	t.Helper()
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]Record, 0, len(files))
	for _, file := range files {
		raw, err := os.ReadFile(filepath.Join(dir, file.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var record Record
		if err := json.Unmarshal(raw, &record); err != nil {
			t.Fatal(err)
		}
		out = append(out, record)
	}
	return out
}

func TestSelectedProviderHTTPRecordsRealWireAndNeverLogsAuthorization(t *testing.T) {
	seen := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen++
		if r.Header.Get("Authorization") != "Bearer synthetic-secret" || r.Header.Get("x-api-key") != "synthetic-other-secret" {
			t.Fatal("source did not receive its credential")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"model":"fixture","input":"say hi"}` {
			t.Fatalf("source request = %q", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, "data: one\n\ndata: two\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()

	dir := t.TempDir()
	recorder, err := New(dir, []string{"capture-case-one"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	client := recorder.Client(server.Client())
	request := func(id string) *http.Request {
		req, err := http.NewRequestWithContext(WithID(context.Background(), id), http.MethodPost, server.URL+"/v1/responses?key=synthetic-query-secret", strings.NewReader(`{"model":"fixture","input":"say hi"}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer synthetic-secret")
		req.Header.Set("x-api-key", "synthetic-other-secret")
		req.Header.Set("Content-Type", "application/json")
		return req
	}
	// Unselected traffic is indistinguishable to its caller and leaves no file.
	first, err := client.Do(request("ordinary-request"))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, first.Body)
	_ = first.Body.Close()
	if got := records(t, dir); len(got) != 0 {
		t.Fatalf("ordinary traffic captured %d request(s)", len(got))
	}

	response, err := client.Do(request("capture-case-one"))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if seen != 2 || string(raw) != "data: one\n\ndata: two\n\ndata: [DONE]\n\n" {
		t.Fatalf("client saw %d request(s), body %q", seen, raw)
	}
	got := records(t, dir)
	if len(got) != 1 || got[0].RequestID != "capture-case-one" || got[0].Status != 200 || !got[0].Complete {
		t.Fatalf("captured envelope = %+v", got)
	}
	if got[0].Path != "/v1/responses" || got[0].RequestHeaders["Content-Type"] != "application/json" {
		t.Fatalf("captured request = %+v", got[0])
	}
	if len(got[0].AuthForms) != 2 || got[0].AuthForms[0] != "bearer" || got[0].AuthForms[1] != "x-api-key" {
		t.Fatalf("capture lost the auth forms while excluding their values: %+v", got[0].AuthForms)
	}
	if decoded, _ := base64.StdEncoding.DecodeString(got[0].RequestBodyBase64); !bytes.Equal(decoded, []byte(`{"model":"fixture","input":"say hi"}`)) {
		t.Fatalf("captured request body differs from source: %q", decoded)
	}
	if decoded, _ := base64.StdEncoding.DecodeString(got[0].ResponseBodyBase64); !bytes.Equal(decoded, raw) {
		t.Fatalf("captured stream differs from client: %q", decoded)
	}
	serialized, _ := json.Marshal(got)
	for _, secret := range []string{"synthetic-secret", "synthetic-other-secret", "synthetic-query-secret"} {
		if bytes.Contains(serialized, []byte(secret)) {
			t.Fatal("capture leaked a source credential")
		}
	}
	if _, err := client.Do(request("capture-case-one")); err == nil {
		t.Fatal("a second upstream attempt exceeded the hard per-host cap")
	}
	if seen != 2 || len(records(t, dir)) != 1 {
		t.Fatal("budget refusal sent an extra upstream request")
	}
	restarted, err := New(dir, []string{"capture-case-one"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Client(server.Client()).Do(request("capture-case-one")); err == nil || seen != 2 {
		t.Fatal("a restarted capture process must keep the same per-host attempt cap")
	}
}

func TestSSERequiresATerminalEvenWhenSourceClosesNormally(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: fragment\n\n")
	}))
	defer server.Close()
	dir := t.TempDir()
	recorder, err := New(dir, []string{"sse-missing-terminal"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(WithID(context.Background(), "sse-missing-terminal"), "POST", server.URL+"/v1/chat/completions", nil)
	resp, err := recorder.Client(server.Client()).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	got := records(t, dir)
	if len(got) != 1 || got[0].Complete || !got[0].TransportEOF || got[0].Failure != "missing_terminal" {
		t.Fatalf("an EOF without SSE terminal cannot become replayable: %+v", got)
	}
}

func TestSSETerminalBeforeTransportEOFIsACompleteCapturedAnswer(t *testing.T) {
	const stream = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, stream)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	dir := t.TempDir()
	recorder, err := New(dir, []string{"sse-terminal"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(WithID(context.Background(), "sse-terminal"), "POST", server.URL+"/v1/chat/completions", nil)
	resp, err := recorder.Client(server.Client()).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(stream))
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	got := records(t, dir)
	if len(got) != 1 || !got[0].Complete || got[0].TransportEOF || got[0].TerminalEvent != "done" {
		t.Fatalf("SSE terminal did not outlive its transport read: %+v", got)
	}
}

func TestSSEFailureEventCannotBeReplayedAsSuccessAfterDone(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: response.failed\ndata: {\"status\":\"failed\"}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	dir := t.TempDir()
	recorder, err := New(dir, []string{"sse-failed"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(WithID(context.Background(), "sse-failed"), "POST", server.URL+"/v1/responses", nil)
	resp, err := recorder.Client(server.Client()).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	got := records(t, dir)
	if len(got) != 1 || got[0].Complete || got[0].TerminalEvent != "response.failed" || got[0].Failure != "terminal_error" {
		t.Fatalf("failed terminal was misclassified: %+v", got)
	}
}

func TestOnlySelectedRequestIDsReachTheAuthenticatedExtension(t *testing.T) {
	var observed []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-extension-secret" {
			t.Error("extension authorization did not survive the forwarding wrapper")
		}
		observed = append(observed, r.Header.Get(ForwardHeader))
		w.WriteHeader(200)
	}))
	defer server.Close()
	previous := configured
	configured, _ = New(t.TempDir(), []string{"selected-extension-request"}, 10)
	t.Cleanup(func() { configured = previous })
	client := Forward(server.Client())
	for _, id := range []string{"ordinary-request", "selected-extension-request"} {
		req, _ := http.NewRequestWithContext(WithID(context.Background(), id), "POST", server.URL+"/extension/v1/fixture/invoke", nil)
		req.Header.Set("Authorization", "Bearer synthetic-extension-secret")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
	}
	if len(observed) != 2 || observed[0] != "" || observed[1] != "selected-extension-request" {
		t.Fatalf("capture marker did not follow only the selected call: %+v", observed)
	}
}

func TestClosingStreamBeforeTerminalMarksCaptureIncomplete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	dir := t.TempDir()
	recorder, err := New(dir, []string{"capture-incomplete"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(WithID(context.Background(), "capture-incomplete"))
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/chat/completions", strings.NewReader(`{"model":"fixture"}`))
	resp, err := recorder.Client(server.Client()).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	chunk := make([]byte, 14)
	if _, err := resp.Body.Read(chunk); err != nil && err != io.EOF {
		t.Fatal(err)
	}
	cancel()
	_ = resp.Body.Close()
	got := records(t, dir)
	if len(got) != 1 || got[0].Complete || got[0].ResponseBytes < 1 {
		t.Fatalf("an interrupted stream must be partial: %+v", got)
	}
}
