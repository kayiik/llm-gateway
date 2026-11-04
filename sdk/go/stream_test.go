package llmgwclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func streamFixtures() map[string][]StreamEvent {
	value := func(event string, data map[string]any) StreamEvent { return StreamEvent{Event: event, Data: data} }
	message := map[string]any{"id": "msg_src", "type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "hello"}}}
	return map[string][]StreamEvent{
		"chat": {
			value("message", map[string]any{"id": "chat_src", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant"}}}}),
			value("message", map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "hel"}}}}),
			value("message", map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "lo"}, "finish_reason": "stop"}}}),
			value("message", map[string]any{"choices": []any{}, "usage": map[string]any{"prompt_tokens": 5, "completion_tokens": 2}}),
			{Event: "message", Data: "[DONE]"},
		},
		"messages": {
			value("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_src", "role": "assistant", "usage": map[string]any{"input_tokens": 5}}}),
			value("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}}),
			value("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "hel"}}),
			value("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "lo"}}),
			value("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0}),
			value("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}, "usage": map[string]any{"output_tokens": 2}}),
			value("message_stop", map[string]any{"type": "message_stop"}),
		},
		"responses": {
			value("response.created", map[string]any{"type": "response.created", "response": map[string]any{"id": "resp_src", "status": "in_progress", "output": []any{}}}),
			value("response.output_item.added", map[string]any{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"id": "msg_src", "type": "message", "role": "assistant", "content": []any{}}}),
			value("response.content_part.added", map[string]any{"type": "response.content_part.added", "output_index": 0, "content_index": 0, "part": map[string]any{"type": "output_text", "text": ""}}),
			value("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "hel"}),
			value("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "lo"}),
			value("response.output_text.done", map[string]any{"type": "response.output_text.done", "text": "hello"}),
			value("response.content_part.done", map[string]any{"type": "response.content_part.done", "output_index": 0, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "hello"}}),
			value("response.output_item.done", map[string]any{"type": "response.output_item.done", "output_index": 0, "item": message}),
			value("response.completed", map[string]any{"type": "response.completed", "response": map[string]any{"id": "resp_src", "status": "completed", "output": []any{message}, "usage": map[string]any{"input_tokens": 5, "output_tokens": 2}}}),
		},
	}
}

func sseWire(events []StreamEvent) []byte {
	var output bytes.Buffer
	for _, event := range events {
		if event.Event != "message" {
			_, _ = output.WriteString("event: " + event.Event + "\r\n")
		}
		data, ok := event.Data.(string)
		if !ok {
			encoded, _ := json.Marshal(event.Data)
			data = string(encoded)
		}
		_, _ = output.WriteString("data: " + data + "\r\n\r\n")
	}
	return output.Bytes()
}

func streamFromFixture(source, target string, events []StreamEvent) *StreamResult {
	return newStreamResult("fixture", "", source, target, "coding", io.NopCloser(bytes.NewReader(sseWire(events))))
}

func drainStream(stream *StreamResult) ([]StreamEvent, error) {
	var output []StreamEvent
	for {
		event, err := stream.Next()
		if errors.Is(err, io.EOF) {
			return output, nil
		}
		if err != nil {
			return output, err
		}
		output = append(output, event)
	}
}

func streamText(events []StreamEvent, target string) string {
	var output strings.Builder
	for _, event := range events {
		data := objectOf(event.Data)
		switch target {
		case "chat":
			for _, item := range listOf(data["choices"]) {
				output.WriteString(stringOf(objectOf(objectOf(item)["delta"])["content"]))
			}
		case "messages":
			if data["type"] == "content_block_delta" {
				output.WriteString(stringOf(objectOf(data["delta"])["text"]))
			}
		case "responses":
			if data["type"] == "response.output_text.delta" {
				output.WriteString(stringOf(data["delta"]))
			}
		}
	}
	return output.String()
}

func TestNineTextStreamDialectPairsAndTruncation(t *testing.T) {
	fixtures := streamFixtures()
	for source, items := range fixtures {
		for target := range fixtures {
			t.Run(source+"-to-"+target, func(t *testing.T) {
				output, err := drainStream(streamFromFixture(source, target, items))
				if err != nil || streamText(output, target) != "hello" {
					t.Fatalf("incremental text mismatch: %v, %q", err, streamText(output, target))
				}
				last := output[len(output)-1]
				if target == "chat" && last.Data != "[DONE]" || target == "messages" && last.Event != "message_stop" || target == "responses" && last.Event != "response.completed" {
					t.Fatalf("unexpected terminal: %s", last.Event)
				}
				if target == "responses" && source != target {
					for index, event := range output {
						if objectOf(event.Data)["sequence_number"] != int64(index) {
							t.Fatal("Responses stream sequence did not advance")
						}
					}
					response := objectOf(objectOf(last.Data)["response"])
					items := listOf(response["output"])
					parts := listOf(objectOf(items[0])["content"])
					if objectOf(parts[0])["text"] != "hello" {
						t.Fatal("Responses terminal did not retain streamed text")
					}
					if objectOf(response["usage"])["total_tokens"] != int64(7) {
						t.Fatal("Responses terminal lost observed usage")
					}
				}
				if source != target {
					partial, err := drainStream(streamFromFixture(source, target, items[:len(items)-1]))
					var protocol *StreamProtocolError
					if !errors.As(err, &protocol) || len(partial) == 0 {
						t.Fatalf("truncated stream appeared complete: %v", err)
					}
				}
			})
		}
	}
}

func TestNativeToolStreamPassesAndConvertedToolStreamFails(t *testing.T) {
	tool := []StreamEvent{
		{Event: "message", Data: map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_1"}}}, "finish_reason": "tool_calls"}}}},
		{Event: "message", Data: "[DONE]"},
	}
	native, err := drainStream(streamFromFixture("chat", "chat", tool))
	if err != nil || len(native) != 2 || native[1].Data != "[DONE]" {
		t.Fatalf("native tool stream was not preserved: %v", err)
	}
	converted, err := drainStream(streamFromFixture("chat", "messages", tool))
	var protocol *StreamProtocolError
	if !errors.As(err, &protocol) {
		t.Fatalf("cross-dialect tool stream was silently accepted: %v", err)
	}
	for _, item := range converted {
		if item.Event == "message_stop" {
			t.Fatal("converted tool stream claimed completion")
		}
	}
}

func TestConvertedStreamRejectsCitationWithoutTerminal(t *testing.T) {
	items := streamFixtures()["responses"]
	items[6] = StreamEvent{Event: "response.content_part.done", Data: map[string]any{
		"type": "response.content_part.done", "output_index": 0, "content_index": 0,
		"part": map[string]any{"type": "output_text", "text": "hello", "annotations": []any{map[string]any{"type": "file_citation"}}},
	}}
	result, err := drainStream(streamFromFixture("responses", "messages", items))
	var protocol *StreamProtocolError
	if !errors.As(err, &protocol) {
		t.Fatalf("citation was silently dropped: %v", err)
	}
	for _, event := range result {
		if event.Event == "message_stop" {
			t.Fatal("citation stream claimed completion")
		}
	}
	items = streamFixtures()["responses"]
	items[7] = StreamEvent{Event: "response.output_item.done", Data: map[string]any{
		"type": "response.output_item.done", "output_index": 0,
		"item": map[string]any{"type": "message", "role": "assistant", "content": []any{
			map[string]any{"type": "output_text", "text": "hello", "annotations": []any{map[string]any{"type": "file_citation"}}},
		}},
	}}
	_, err = drainStream(streamFromFixture("responses", "chat", items))
	if !errors.As(err, &protocol) {
		t.Fatalf("output item citation was silently dropped: %v", err)
	}
}

func TestResponsesDoneEventCanSupplyTextWithoutPriorDelta(t *testing.T) {
	var events []StreamEvent
	for _, event := range streamFixtures()["responses"] {
		if event.Event != "response.output_text.delta" {
			events = append(events, event)
		}
	}
	output, err := drainStream(streamFromFixture("responses", "chat", events))
	if err != nil || streamText(output, "chat") != "hello" || output[len(output)-1].Data != "[DONE]" {
		t.Fatalf("done-only text was not converted: %v", err)
	}
}

func TestMalformedSSEDataCannotComplete(t *testing.T) {
	stream := newStreamResult("fixture", "", "chat", "chat", "coding", io.NopCloser(strings.NewReader("data: {broken}\n\n")))
	_, err := stream.Next()
	var protocol *StreamProtocolError
	if !errors.As(err, &protocol) {
		t.Fatalf("malformed event was accepted: %v", err)
	}
}

func TestStalledStreamReportsIdleTimeout(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	stream := newStreamResult("fixture", "", "chat", "chat", "coding", reader)
	stream.idleTimeout = 20 * time.Millisecond
	_, err := stream.Next()
	var protocol *StreamProtocolError
	if !errors.As(err, &protocol) || !strings.Contains(err.Error(), "idle timeout") {
		t.Fatalf("stalled stream did not time out: %v", err)
	}
}

func TestSSEKeepaliveBytesResetIdleTimeout(t *testing.T) {
	reader, writer := io.Pipe()
	stream := newStreamResult("fixture", "", "chat", "chat", "coding", reader)
	stream.idleTimeout = 80 * time.Millisecond
	go func() {
		defer writer.Close()
		for range 5 {
			_, _ = writer.Write([]byte(": keepalive\n\n"))
			time.Sleep(25 * time.Millisecond)
		}
		_, _ = writer.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
	}()
	events, err := drainStream(stream)
	if err != nil || streamText(events, "chat") != "hi" {
		t.Fatalf("keepalives were treated as idle: %v", err)
	}
}

type signalingBody struct {
	io.ReadCloser
	started chan struct{}
	once    sync.Once
}

func (b *signalingBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	return b.ReadCloser.Read(p)
}

func TestCloseUnblocksAStreamRead(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	body := &signalingBody{ReadCloser: reader, started: make(chan struct{})}
	stream := newStreamResult("fixture", "", "chat", "chat", "coding", body)
	result := make(chan error, 1)
	go func() { _, err := stream.Next(); result <- err }()
	<-body.started
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("closing a pending read did not cancel it: %v", err)
	}
}

func TestStreamGatewayFirstAndOpenedFailureCannotReplay(t *testing.T) {
	var secondCalls atomic.Int64
	var refusedCalls atomic.Int64
	fail := false
	refused := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refusedCalls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer refused.Close()
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		items := streamFixtures()["messages"]
		if fail {
			items = append(append([]StreamEvent{}, items[:3]...), StreamEvent{Event: "error", Data: map[string]any{"type": "error", "error": map[string]any{"type": "api_error"}}})
		}
		_, _ = w.Write(sseWire(items))
	}))
	defer local.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secondCalls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write(sseWire(streamFixtures()["chat"]))
	}))
	defer second.Close()
	snapshot := Snapshot{Version: 1, Selectors: map[string]Selector{"coding": {Targets: []string{"refused/model", "local/model", "second/model"}, Ingress: []string{"/v1/chat/completions"}, AllowAdaptation: true}},
		Targets: map[string]Target{
			"refused/model": {Model: "model", Dialect: "messages", BaseURL: refused.URL, APIKey: "fixture"},
			"local/model":   {Model: "model", Dialect: "messages", BaseURL: local.URL, APIKey: "fixture"},
			"second/model":  {Model: "model", Dialect: "chat", BaseURL: second.URL, APIKey: "fixture"},
		}}
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if r.URL.Path == "/v1/client-snapshot" {
			_ = json.NewEncoder(w).Encode(snapshot)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write(sseWire(streamFixtures()["chat"]))
	}))
	cache := filepath.Join(t.TempDir(), "snapshot.json")
	client, err := New(gateway.URL, "project-key", cache, func(string, string) []string { return []string{"refused/model", "local/model", "second/model"} })
	if err != nil {
		t.Fatal(err)
	}
	client.ShouldTryNext = func(error, string) bool { return true }
	if err := client.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}, "max_tokens": 32, "stream": true}
	online, err := client.Stream(context.Background(), "chat", "coding", body)
	if err != nil || online.Source != "gateway" {
		t.Fatalf("gateway stream did not open: %v", err)
	}
	if events, err := drainStream(online); err != nil || streamText(events, "chat") != "hello" {
		t.Fatalf("gateway stream failed: %v", err)
	}
	gateway.Close()
	client.LocalTargets = func(string, string) []string { return []string{"refused/model", "second/model"} }
	native, err := client.Stream(context.Background(), "chat", "coding", body)
	if err != nil || native.Target != "second/model" {
		t.Fatalf("opening refusal did not advance to a native target: %v", err)
	}
	if events, err := drainStream(native); err != nil || streamText(events, "chat") != "hello" {
		t.Fatalf("native fallback stream failed: %v", err)
	}
	secondCalls.Store(0)
	client.LocalTargets = func(string, string) []string { return []string{"refused/model", "local/model", "second/model"} }
	offline, err := client.Stream(context.Background(), "chat", "coding", body)
	if err != nil || offline.Source != "direct" || offline.Target != "local/model" {
		t.Fatalf("local stream did not open: %v", err)
	}
	if refusedCalls.Load() != 2 {
		t.Fatal("opening refusal did not advance to the next target")
	}
	if events, err := drainStream(offline); err != nil || streamText(events, "chat") != "hello" {
		t.Fatalf("local stream conversion failed: %v", err)
	}
	cancelled, err := client.Stream(context.Background(), "chat", "coding", body)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cancelled.Next(); err != nil {
		t.Fatal(err)
	}
	_ = cancelled.Close()
	if _, err := cancelled.Next(); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled stream kept yielding: %v", err)
	}
	fail = true
	partial, err := client.Stream(context.Background(), "chat", "coding", body)
	if err != nil {
		t.Fatal(err)
	}
	events, err := drainStream(partial)
	var protocol *StreamProtocolError
	if !errors.As(err, &protocol) || streamText(events, "chat") != "hel" || secondCalls.Load() != 0 {
		t.Fatalf("opened stream replayed or completed: %v, %q, next %d", err, streamText(events, "chat"), secondCalls.Load())
	}
	if refusedCalls.Load() != 4 {
		t.Fatal("opening refusal did not advance for each local stream")
	}
}
