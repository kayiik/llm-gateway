// Package capture records selected outbound HTTP attempts without changing the
// request or response bytes the provider and caller exchange.
package capture

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const bodyLimit = 32 << 20

type requestIDKey struct{}

const ForwardHeader = "X-LLMGW-Capture-ID"

func WithID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, id)
}

// Record is a private observation of an actual outbound attempt. Headers are
// allowlisted, and bodies are base64 because SSE and media are not always JSON.
// A short read, cancellation or size cap never claims a replayable result.
type Record struct {
	RequestID          string            `json:"request_id"`
	StartedAt          string            `json:"started_at"`
	DurationMS         int64             `json:"duration_ms"`
	Host               string            `json:"host"`
	Method             string            `json:"method"`
	Path               string            `json:"path"`
	Query              string            `json:"query,omitempty"`
	AuthForms          []string          `json:"auth_forms,omitempty"`
	RequestHeaders     map[string]string `json:"request_headers"`
	ResponseHeaders    map[string]string `json:"response_headers,omitempty"`
	RequestBodyBase64  string            `json:"request_body_base64,omitempty"`
	ResponseBodyBase64 string            `json:"response_body_base64,omitempty"`
	RequestBytes       int64             `json:"request_bytes"`
	ResponseBytes      int64             `json:"response_bytes"`
	RequestSHA256      string            `json:"request_sha256"`
	ResponseSHA256     string            `json:"response_sha256,omitempty"`
	RequestTruncated   bool              `json:"request_truncated,omitempty"`
	ResponseTruncated  bool              `json:"response_truncated,omitempty"`
	RequestComplete    bool              `json:"request_complete"`
	TransportEOF       bool              `json:"transport_eof"`
	TerminalEvent      string            `json:"terminal_event,omitempty"`
	Status             int               `json:"status"`
	Complete           bool              `json:"complete"`
	Failure            string            `json:"failure,omitempty"`
}

type Recorder struct {
	dir      string
	selected map[string]bool
	max      int
	mu       sync.Mutex
	attempts map[string]int
}

func New(dir string, ids []string, max int) (*Recorder, error) {
	if strings.TrimSpace(dir) == "" || len(ids) == 0 || max < 1 || max > 10 {
		return nil, errors.New("capture needs a private directory, selected request IDs and a cap of 1–10 attempts per host")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, errors.New("capture directory could not be prepared")
	}
	probe, err := os.CreateTemp(dir, ".capture-probe-*")
	if err != nil {
		return nil, errors.New("capture directory is not writable")
	}
	_ = probe.Close()
	_ = os.Remove(probe.Name())
	selected := make(map[string]bool, len(ids))
	for _, id := range ids {
		if id == "" || strings.ContainsAny(id, "\n\r\t /\\") {
			return nil, errors.New("capture request ID is invalid")
		}
		selected[id] = true
	}
	attempts := make(map[string]int)
	files, err := os.ReadDir(dir)
	if err != nil {
		return nil, errors.New("capture attempt evidence could not be listed")
	}
	for _, file := range files {
		if strings.HasSuffix(file.Name(), ".tmp") {
			return nil, errors.New("an unfinished capture attempt requires operator reconciliation")
		}
		if !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, file.Name()))
		if err != nil {
			return nil, errors.New("capture attempt evidence could not be read")
		}
		var previous Record
		if json.Unmarshal(raw, &previous) != nil || previous.Host == "" || previous.RequestID == "" {
			return nil, errors.New("capture attempt evidence could not be validated")
		}
		attempts[previous.Host]++
	}
	return &Recorder{dir: dir, selected: selected, max: max, attempts: attempts}, nil
}

var configured *Recorder

// ConfigureFromEnv must run before serving requests. A partial opt-in fails
// startup rather than silently omitting evidence for calls the operator chose.
func ConfigureFromEnv() error {
	dir, raw := os.Getenv("LLMGW_CAPTURE_DIR"), os.Getenv("LLMGW_CAPTURE_REQUEST_IDS")
	if dir == "" && raw == "" {
		configured = nil
		return nil
	}
	max := 10
	if value := os.Getenv("LLMGW_CAPTURE_MAX_ATTEMPTS"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return errors.New("capture attempt cap must be an integer from 1 to 10")
		}
		max = parsed
	}
	r, err := New(dir, strings.Split(raw, ","), max)
	if err != nil {
		return err
	}
	configured = r
	return nil
}

func Wrap(client *http.Client) *http.Client {
	if configured == nil {
		return client
	}
	return configured.Client(client)
}

// Forward names one selected request for a separately authenticated extension.
// It does not put a credential or a body into a logging header.
func Forward(client *http.Client) *http.Client {
	if configured == nil {
		return client
	}
	copy := *client
	transport := copy.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	copy.Transport = &forwardTransport{next: transport, selected: configured.selected}
	return &copy
}

type forwardTransport struct {
	next     http.RoundTripper
	selected map[string]bool
}

func (t *forwardTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	id, _ := req.Context().Value(requestIDKey{}).(string)
	if !t.selected[id] {
		return t.next.RoundTrip(req)
	}
	forwarded := req.Clone(req.Context())
	forwarded.Header = req.Header.Clone()
	forwarded.Header.Set(ForwardHeader, id)
	return t.next.RoundTrip(forwarded)
}

func (r *Recorder) Client(client *http.Client) *http.Client {
	if client == nil {
		client = http.DefaultClient
	}
	copy := *client
	transport := copy.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	copy.Transport = &recordingTransport{next: transport, recorder: r}
	return &copy
}

type recordingTransport struct {
	next     http.RoundTripper
	recorder *Recorder
}

func (t *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	id, _ := req.Context().Value(requestIDKey{}).(string)
	if !t.recorder.selected[id] || !eligiblePath(req.URL.Path) {
		return t.next.RoundTrip(req)
	}
	host := strings.ToLower(req.URL.Hostname())
	t.recorder.mu.Lock()
	attempt := t.recorder.attempts[host] + 1
	if attempt > t.recorder.max {
		t.recorder.mu.Unlock()
		return nil, errors.New("capture attempt cap reached before an upstream request")
	}
	t.recorder.attempts[host] = attempt
	t.recorder.mu.Unlock()

	record := Record{
		RequestID: id, StartedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Host: host, Method: req.Method, Path: req.URL.EscapedPath(),
		Query: safeQuery(req.URL), RequestHeaders: safeHeaders(req.Header), AuthForms: authForms(req.Header),
	}
	started := time.Now()
	if err := t.recorder.reserve(id, host, attempt, record); err != nil {
		return nil, err
	}
	var outbound trackedBody
	outbound.body = req.Body
	if req.Body != nil && req.Body != http.NoBody {
		forwarded := req.Clone(req.Context())
		forwarded.Body = &outbound
		req = forwarded
	}
	response, err := t.next.RoundTrip(req)
	recordRequest := func() {
		request := outbound.snapshot()
		record.RequestBytes, record.RequestBodyBase64 = request.size, request.body
		record.RequestSHA256, record.RequestTruncated = request.sha, request.truncated
		record.RequestComplete = req.Body == nil || req.Body == http.NoBody || request.eof || (req.ContentLength >= 0 && request.size == req.ContentLength)
	}
	if err != nil {
		recordRequest()
		record.DurationMS = time.Since(started).Milliseconds()
		record.Failure = "transport_error"
		if req.Context().Err() != nil {
			record.Failure = "cancelled"
		}
		t.recorder.save(id, host, attempt, record)
		return nil, err
	}
	record.Status = response.StatusCode
	record.ResponseHeaders = safeHeaders(response.Header)
	streaming := strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream")
	if response.Body == nil || response.Body == http.NoBody {
		recordRequest()
		record.DurationMS = time.Since(started).Milliseconds()
		record.TransportEOF = true
		record.Complete = record.RequestComplete && !streaming
		if streaming {
			record.Failure = "missing_terminal"
		}
		record.ResponseSHA256 = sha256Hex(nil)
		t.recorder.save(id, host, attempt, record)
		return response, nil
	}
	response.Body = &responseBody{body: trackedBody{body: response.Body}, done: func(snapshot bodySnapshot, complete bool) {
		recordRequest()
		record.DurationMS = time.Since(started).Milliseconds()
		record.ResponseBytes, record.ResponseBodyBase64 = snapshot.size, snapshot.body
		record.ResponseSHA256, record.ResponseTruncated = snapshot.sha, snapshot.truncated
		record.TransportEOF = complete
		if streaming {
			record.TerminalEvent = sseTerminal(snapshot.body)
			record.Complete = record.RequestComplete && !snapshot.truncated && (record.TerminalEvent == "done" || record.TerminalEvent == "response.completed" || record.TerminalEvent == "message_stop")
			if !record.Complete {
				record.Failure = "missing_terminal"
				if record.TerminalEvent == "response.failed" || record.TerminalEvent == "error" {
					record.Failure = "terminal_error"
				}
			}
		} else {
			record.Complete = record.RequestComplete && complete && !snapshot.truncated
			if !record.Complete {
				record.Failure = "response_not_fully_read"
			}
		}
		t.recorder.save(id, host, attempt, record)
	}}
	return response, nil
}

func eligiblePath(path string) bool {
	path = strings.ToLower(path)
	return !strings.Contains(path, "/oauth") && !strings.HasSuffix(path, "/token") && !strings.Contains(path, "/token/")
}

func safeQuery(address *url.URL) string {
	values := address.Query()
	safe := make(url.Values)
	for _, key := range []string{"alt", "api-version", "pageSize", "pageToken", "after"} {
		if entries, ok := values[key]; ok {
			safe[key] = entries
		}
	}
	return safe.Encode()
}

func safeHeaders(headers http.Header) map[string]string {
	out := make(map[string]string)
	for _, key := range []string{"Content-Type", "Accept", "Anthropic-Version", "X-Vertex-AI-LLM-Request-Type", "Retry-After", "ETag"} {
		if value := headers.Get(key); value != "" {
			out[key] = value
		}
	}
	return out
}

func authForms(headers http.Header) []string {
	var forms []string
	if value := headers.Get("Authorization"); value != "" {
		scheme, _, _ := strings.Cut(value, " ")
		if strings.EqualFold(scheme, "Bearer") || strings.EqualFold(scheme, "Basic") {
			forms = append(forms, strings.ToLower(scheme))
		} else {
			forms = append(forms, "authorization")
		}
	}
	for _, key := range []string{"api-key", "x-api-key", "xi-api-key", "x-goog-api-key"} {
		if headers.Get(key) != "" {
			forms = append(forms, key)
		}
	}
	return forms
}

type bodySnapshot struct {
	size      int64
	body      string
	sha       string
	truncated bool
	eof       bool
}

type trackedBody struct {
	mu   sync.Mutex
	body io.ReadCloser
	buf  bytes.Buffer
	hash hash.Hash
	size int64
	eof  bool
}

func (b *trackedBody) Read(p []byte) (int, error) {
	n, err := b.body.Read(p)
	b.mu.Lock()
	defer b.mu.Unlock()
	if err == io.EOF {
		b.eof = true
	}
	if n > 0 {
		b.size += int64(n)
		if b.buf.Len() < bodyLimit {
			keep := min(n, bodyLimit-b.buf.Len())
			_, _ = b.buf.Write(p[:keep])
		}
		if b.hash == nil {
			b.hash = sha256.New()
		}
		_, _ = b.hash.Write(p[:n])
	}
	return n, err
}

func (b *trackedBody) Close() error { return b.body.Close() }

func (b *trackedBody) snapshot() bodySnapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.hash == nil {
		b.hash = sha256.New()
	}
	return bodySnapshot{size: b.size, body: base64.StdEncoding.EncodeToString(b.buf.Bytes()), sha: hex.EncodeToString(b.hash.Sum(nil)), truncated: b.size > bodyLimit, eof: b.eof}
}

type responseBody struct {
	body trackedBody
	done func(bodySnapshot, bool)
	once sync.Once
	eof  bool
}

func (b *responseBody) Read(p []byte) (int, error) {
	n, err := b.body.Read(p)
	if err == io.EOF {
		b.eof = true
		b.finish()
	}
	return n, err
}

func (b *responseBody) Close() error {
	err := b.body.Close()
	b.finish()
	return err
}

func (b *responseBody) finish() { b.once.Do(func() { b.done(b.body.snapshot(), b.eof) }) }

func (r *Recorder) save(id, host string, attempt int, record Record) {
	raw, err := json.Marshal(record)
	if err != nil {
		return
	}
	name := captureName(id, host, attempt)
	temp := filepath.Join(r.dir, name+".tmp")
	if err := os.WriteFile(temp, append(raw, '\n'), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "selected upstream capture could not be saved")
		return
	}
	if err := os.Rename(temp, filepath.Join(r.dir, name)); err != nil {
		fmt.Fprintln(os.Stderr, "selected upstream capture could not be finalized")
	}
}

func (r *Recorder) reserve(id, host string, attempt int, record Record) error {
	raw, _ := json.Marshal(record)
	file, err := os.OpenFile(filepath.Join(r.dir, captureName(id, host, attempt)+".tmp"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return errors.New("capture attempt could not be reserved before upstream dispatch")
	}
	_, writeErr := file.Write(raw)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return errors.New("capture attempt could not be persisted before upstream dispatch")
	}
	return nil
}

func captureName(id, host string, attempt int) string {
	return sha256Hex([]byte(id))[:16] + "-" + sha256Hex([]byte(host))[:12] + "-" + strconv.Itoa(attempt) + ".json"
}

func sha256Hex(raw []byte) string {
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}

func sseTerminal(base64Body string) string {
	raw, err := base64.StdEncoding.DecodeString(base64Body)
	if err != nil {
		return ""
	}
	terminal := ""
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if bytes.Equal(line, []byte("data: [DONE]")) {
			terminal = "done"
		}
		if !bytes.HasPrefix(line, []byte("event:")) {
			continue
		}
		event := strings.TrimSpace(string(bytes.TrimPrefix(line, []byte("event:"))))
		if event == "response.failed" || event == "error" {
			return event
		}
		if event == "response.completed" || event == "message_stop" {
			terminal = event
		}
	}
	return terminal
}
