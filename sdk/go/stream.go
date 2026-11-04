package llmgwclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type StreamProtocolError struct{ Reason string }

func (e *StreamProtocolError) Error() string { return e.Reason }

type StreamEvent struct {
	Event string
	Data  any // a decoded JSON object or Chat's "[DONE]"
}

type sseReader struct{ lines *bufio.Reader }

type notifyingReader struct {
	source  io.Reader
	onBytes func()
}

func (r *notifyingReader) Read(p []byte) (int, error) {
	n, err := r.source.Read(p)
	if n > 0 && r.onBytes != nil {
		r.onBytes()
	}
	return n, err
}

type streamBody struct {
	io.ReadCloser
	transport *http.Transport
}

func (b *streamBody) Close() error {
	err := b.ReadCloser.Close()
	if b.transport != nil {
		b.transport.CloseIdleConnections()
	}
	return err
}

func (p *sseReader) next() (StreamEvent, error) {
	event := "message"
	var data []string
	size := 0
	for {
		line, err := p.lines.ReadString('\n')
		if err != nil {
			if errors.Is(err, io.EOF) && line == "" && len(data) == 0 {
				return StreamEvent{}, io.EOF
			}
			return StreamEvent{}, &StreamProtocolError{"SSE stream ended inside an event"}
		}
		size += len(line)
		if size > 1_048_576 {
			return StreamEvent{}, &StreamProtocolError{"SSE event exceeds the size limit"}
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			if len(data) == 0 {
				event = "message"
				continue
			}
			raw := strings.Join(data, "\n")
			if raw == "[DONE]" {
				return StreamEvent{Event: event, Data: raw}, nil
			}
			var value map[string]any
			if json.Unmarshal([]byte(raw), &value) != nil || value == nil {
				return StreamEvent{}, &StreamProtocolError{"SSE event is not a JSON object"}
			}
			return StreamEvent{Event: event, Data: value}, nil
		}
		if strings.HasPrefix(line, "event:") {
			event = strings.TrimLeft(line[6:], " ")
		} else if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimLeft(line[5:], " "))
		}
	}
}

// StreamResult owns a response body. Next reports io.EOF only after a valid
// terminal event; close or cancel an unfinished stream to stop upstream work.
type StreamResult struct {
	Source, Target string
	body           io.ReadCloser
	reader         *sseReader
	observer       *notifyingReader
	bridge         *textStreamBridge
	dialect        string
	queue          []StreamEvent
	finished       atomic.Bool
	chatFinish     bool
	cancelled      atomic.Bool
	closeOnce      sync.Once
	closeErr       error
	idleTimeout    time.Duration
}

func (s *StreamResult) Close() error {
	if !s.finished.Load() {
		s.cancelled.Store(true)
	}
	s.closeOnce.Do(func() { s.closeErr = s.body.Close() })
	return s.closeErr
}

func (s *StreamResult) Next() (StreamEvent, error) {
	for {
		if s.cancelled.Load() {
			return StreamEvent{}, context.Canceled
		}
		if len(s.queue) > 0 {
			value := s.queue[0]
			s.queue = s.queue[1:]
			return value, nil
		}
		if s.finished.Load() {
			_ = s.Close()
			return StreamEvent{}, io.EOF
		}
		idle := s.idleTimeout
		if idle <= 0 {
			idle = 30 * time.Second
		}
		var expired atomic.Bool
		timer := time.AfterFunc(idle, func() {
			expired.Store(true)
			_ = s.Close()
		})
		s.observer.onBytes = func() {
			if !expired.Load() {
				timer.Reset(idle)
			}
		}
		record, err := s.reader.next()
		timer.Stop()
		s.observer.onBytes = nil
		if expired.Load() {
			_ = s.Close()
			return StreamEvent{}, &StreamProtocolError{"SSE stream idle timeout"}
		}
		if err != nil {
			wasCancelled := s.cancelled.Load()
			_ = s.Close()
			if wasCancelled {
				return StreamEvent{}, context.Canceled
			}
			if errors.Is(err, io.EOF) {
				return StreamEvent{}, &StreamProtocolError{"upstream stream ended before its terminal event"}
			}
			return StreamEvent{}, err
		}
		if s.cancelled.Load() {
			return StreamEvent{}, context.Canceled
		}
		if s.bridge != nil {
			s.queue, err = s.bridge.feed(record)
			s.finished.Store(s.bridge.finished)
		} else {
			err = s.acceptNative(record)
			if err == nil {
				s.queue = []StreamEvent{record}
			}
		}
		if err != nil {
			_ = s.Close()
			return StreamEvent{}, err
		}
	}
}

func (s *StreamResult) acceptNative(record StreamEvent) error {
	value, isMap := record.Data.(map[string]any)
	if record.Event == "error" || isMap && (value["error"] != nil || value["type"] == "error" || value["type"] == "response.failed") {
		return &StreamProtocolError{"upstream stream reported an error"}
	}
	switch s.dialect {
	case "chat":
		if record.Data == "[DONE]" {
			if !s.chatFinish {
				return &StreamProtocolError{"Chat stream ended without a finish reason"}
			}
			s.finished.Store(true)
			return nil
		}
		for _, raw := range listOf(value["choices"]) {
			if choice, ok := raw.(map[string]any); ok && choice["finish_reason"] != nil {
				s.chatFinish = true
			}
		}
	case "messages":
		s.finished.Store(value["type"] == "message_stop")
	case "responses":
		s.finished.Store(value["type"] == "response.completed" || value["type"] == "response.incomplete")
	}
	return nil
}

func (c *Client) openStream(ctx context.Context, url, key, dialect string, body map[string]any) (io.ReadCloser, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")
	if dialect == "messages" {
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	streamClient := *client
	streamClient.Timeout = 0 // A healthy stream may last longer than one JSON call.
	var owned *http.Transport
	if client.Transport == nil {
		owned = http.DefaultTransport.(*http.Transport).Clone()
		owned.ResponseHeaderTimeout = 30 * time.Second
		streamClient.Transport = owned
	}
	response, err := streamClient.Do(req)
	if err != nil {
		if owned != nil {
			owned.CloseIdleConnections()
		}
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_ = response.Body.Close()
		if owned != nil {
			owned.CloseIdleConnections()
		}
		return nil, &CallError{response.StatusCode}
	}
	if !strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		_ = response.Body.Close()
		if owned != nil {
			owned.CloseIdleConnections()
		}
		return nil, &UnsupportedRequest{"upstream did not open an SSE stream"}
	}
	return &streamBody{ReadCloser: response.Body, transport: owned}, nil
}

func newStreamResult(source, target, sourceDialect, callerDialect, model string, body io.ReadCloser) *StreamResult {
	observer := &notifyingReader{source: body}
	result := &StreamResult{Source: source, Target: target, body: body, reader: &sseReader{bufio.NewReader(observer)}, observer: observer, dialect: callerDialect}
	if sourceDialect != callerDialect {
		result.bridge = newTextStreamBridge(sourceDialect, callerDialect, model)
	}
	return result
}

func (c *Client) Stream(ctx context.Context, dialect, selector string, body map[string]any) (*StreamResult, error) {
	path, ok := paths[dialect]
	if !ok {
		return nil, errors.New("unknown caller dialect")
	}
	if body["stream"] == false {
		return nil, &UnsupportedRequest{"stream requires streaming output"}
	}
	c.refreshIfStale()
	input := make(map[string]any, len(body)+2)
	for k, v := range body {
		input[k] = v
	}
	input["model"] = selector
	input["stream"] = true
	opened, err := c.openStream(ctx, c.URL+path, c.Key, dialect, input)
	if err == nil {
		result := newStreamResult("gateway", "", dialect, dialect, selector, opened)
		result.idleTimeout = c.StreamIdleTimeout
		return result, nil
	}
	var op *net.OpError
	var upstream *CallError
	proxyOutage := errors.As(err, &upstream) && (upstream.Status == 502 || upstream.Status == 503 || upstream.Status == 504) && c.IsGatewayUnavailable != nil && c.IsGatewayUnavailable(err)
	if !proxyOutage && (!errors.As(err, &op) || op.Op != "dial") {
		return nil, err
	}
	c.mu.Lock()
	snapshot := c.snapshot
	c.mu.Unlock()
	if snapshot == nil {
		return nil, errors.New("gateway unavailable and no local snapshot is saved")
	}
	entry, ok := snapshot.Selectors[selector]
	if !ok {
		return nil, errors.New("selector is not available in the saved snapshot")
	}
	if len(entry.Ingress) > 0 {
		permitted := false
		for _, pathAllowed := range entry.Ingress {
			if pathAllowed == path {
				permitted = true
			}
		}
		if !permitted {
			return nil, &UnsupportedRequest{"this route does not permit the caller dialect"}
		}
	}
	allowed := map[string]bool{}
	for _, id := range entry.Targets {
		allowed[id] = true
	}
	if c.LocalTargets == nil {
		return nil, errors.New("no local targets were selected")
	}
	var last error
	for _, id := range c.LocalTargets(selector, dialect) {
		last = nil
		if !allowed[id] {
			return nil, errors.New("local target is not permitted for this selector")
		}
		target, ok := snapshot.Targets[id]
		if !ok {
			return nil, errors.New("local target is missing from snapshot")
		}
		if paths[target.Dialect] == "" {
			last = &UnsupportedRequest{"unknown target dialect"}
		} else if target.ExpiresAt > 0 && time.Now().Unix() >= target.ExpiresAt {
			last = &UnsupportedRequest{"local credential has expired"}
		} else if target.Dialect != dialect && !entry.AllowAdaptation {
			last = &UnsupportedRequest{"conversion is not allowed for this selector"}
		} else {
			var outgoing map[string]any
			if target.Dialect == dialect {
				outgoing = make(map[string]any, len(input))
				for key, value := range input {
					outgoing[key] = value
				}
				outgoing["model"] = target.Model
			} else {
				shape := make(map[string]any, len(body)+1)
				for key, value := range body {
					if key != "stream" {
						shape[key] = value
					}
				}
				shape["model"] = selector
				var turns []turn
				var limit int
				turns, limit, last = readTurns(dialect, shape)
				if last == nil {
					outgoing, last = encode(target.Dialect, target.Model, turns, limit)
				}
				if last == nil {
					outgoing["stream"] = true
				}
			}
			if last == nil {
				root := strings.TrimRight(target.BaseURL, "/")
				if !strings.HasSuffix(root, "/v1") {
					root += "/v1"
				}
				var upstreamBody io.ReadCloser
				upstreamBody, last = c.openStream(ctx, root+paths[target.Dialect][3:], target.APIKey, target.Dialect, outgoing)
				if last == nil {
					result := newStreamResult("direct", id, target.Dialect, dialect, selector, upstreamBody)
					result.idleTimeout = c.StreamIdleTimeout
					return result, nil
				}
			}
		}
		if c.ShouldTryNext == nil || !c.ShouldTryNext(last, id) {
			return nil, last
		}
	}
	if last != nil {
		return nil, last
	}
	return nil, errors.New("no local targets were selected")
}

func listOf(value any) []any {
	list, _ := value.([]any)
	return list
}
