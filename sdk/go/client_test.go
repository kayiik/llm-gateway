package llmgwclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGatewayFirstThenLocalDialectCascade(t *testing.T) {
	badCalls, goodCalls := 0, 0
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		badCalls++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		goodCalls++
		if r.URL.Path != "/v1/messages" {
			t.Errorf("path = %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "native" {
			t.Errorf("model = %v", body["model"])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"type": "message", "stop_reason": "end_turn", "content": []any{map[string]any{"type": "text", "text": "hello"}}})
	}))
	defer good.Close()
	snapshot := Snapshot{Version: 1, Selectors: map[string]Selector{"coding": {Targets: []string{"bad/native", "good/native"}, AllowAdaptation: true}},
		Targets: map[string]Target{
			"bad/native":  {Model: "native", Dialect: "chat", BaseURL: bad.URL, APIKey: "bad"},
			"good/native": {Model: "native", Dialect: "messages", BaseURL: good.URL, APIKey: "good"},
		}}
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/client-snapshot" {
			_ = json.NewEncoder(w).Encode(snapshot)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "online"}}}})
	}))
	cache := filepath.Join(t.TempDir(), "snapshot.json")
	plan := func(string, string) []string { return []string{"bad/native", "good/native"} }
	c, err := New(gateway.URL, "project-key", cache, plan)
	if err != nil {
		t.Fatal(err)
	}
	c.ShouldTryNext = func(err error, _ string) bool {
		var call *CallError
		return errors.As(err, &call) && call.Status == http.StatusUnauthorized
	}
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := New(gateway.URL, "another-project-key", cache, plan); err == nil {
		t.Fatal("cached credentials crossed project keys")
	}
	if _, err := New("http://127.0.0.1:1", "project-key", cache, plan); err == nil {
		t.Fatal("cached credentials crossed gateway URLs")
	}
	input := map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}, "max_tokens": 32}
	online, err := c.CallWithInfo(context.Background(), "chat", "coding", input)
	if err != nil || online.Data["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)["content"] != "online" || badCalls != 0 || online.Source != "gateway" {
		t.Fatalf("gateway-first call: %+v %v, bad calls %d", online, err, badCalls)
	}
	gateway.Close()
	offline, err := c.CallWithInfo(context.Background(), "chat", "coding", input)
	if err != nil || offline.Data["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)["content"] != "hello" || badCalls != 1 || goodCalls != 1 || offline.Source != "direct" || offline.Target != "good/native" {
		t.Fatalf("local cascade: %+v %v, calls %d %d", offline, err, badCalls, goodCalls)
	}
	restarted, err := New(gateway.URL, "project-key", cache, func(string, string) []string { return []string{"good/native"} })
	if err != nil {
		t.Fatal(err)
	}
	response, err := restarted.Call(context.Background(), "responses", "coding", map[string]any{"input": "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if response["output"].([]any)[0].(map[string]any)["content"].([]any)[0].(map[string]any)["text"] != "hello" {
		t.Fatalf("response: %+v", response)
	}
	_, err = restarted.Call(context.Background(), "chat", "coding", map[string]any{"messages": input["messages"], "tools": []any{map[string]any{"type": "function"}}})
	var unsupported *UnsupportedRequest
	if !errors.As(err, &unsupported) || goodCalls != 2 {
		t.Fatalf("unsupported field reached upstream: %v, calls %d", err, goodCalls)
	}
	restarted.snapshot.Selectors["coding"] = Selector{Targets: []string{"good/native"}, Ingress: []string{"/v1/messages"}, AllowAdaptation: true}
	_, err = restarted.Call(context.Background(), "chat", "coding", input)
	if !errors.As(err, &unsupported) || goodCalls != 2 {
		t.Fatalf("route ingress was bypassed: %v, calls %d", err, goodCalls)
	}
	restarted.snapshot.Selectors["coding"] = Selector{Targets: []string{"good/native"}, AllowAdaptation: true}
	expired := restarted.snapshot.Targets["good/native"]
	expired.ExpiresAt = 1
	restarted.snapshot.Targets["good/native"] = expired
	_, err = restarted.Call(context.Background(), "chat", "coding", input)
	if !errors.As(err, &unsupported) || goodCalls != 2 {
		t.Fatalf("expired credential reached upstream: %v, calls %d", err, goodCalls)
	}
}

func TestPlainTextDialectMatrix(t *testing.T) {
	inputs := map[string]map[string]any{
		"chat":      {"model": "coding", "messages": []any{map[string]any{"role": "user", "content": "hi"}}, "max_tokens": 32},
		"responses": {"model": "coding", "input": "hi", "max_output_tokens": 32},
		"messages":  {"model": "coding", "messages": []any{map[string]any{"role": "user", "content": "hi"}}, "max_tokens": 32},
	}
	answers := map[string]map[string]any{
		"chat":      {"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": "hello"}}}},
		"responses": {"status": "completed", "output": []any{map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": "hello"}}}}},
		"messages":  {"stop_reason": "end_turn", "content": []any{map[string]any{"type": "text", "text": "hello"}}},
	}
	for ingress, body := range inputs {
		for target, answer := range answers {
			t.Run(ingress+"-to-"+target, func(t *testing.T) {
				turns, limit, err := readTurns(ingress, body)
				if err != nil {
					t.Fatal(err)
				}
				encoded, err := encode(target, "native", turns, limit)
				if err != nil || encoded["model"] != "native" {
					t.Fatalf("encode: %+v %v", encoded, err)
				}
				value, err := readText(target, answer)
				if err != nil || value != "hello" {
					t.Fatalf("target response: %q %v", value, err)
				}
				decoded := decode(ingress, "coding", value)
				value, err = readText(ingress, decoded)
				if err != nil || value != "hello" {
					t.Fatalf("caller response: %q %v", value, err)
				}
			})
		}
	}
	_, err := readText("messages", map[string]any{"stop_reason": "tool_use", "content": []any{map[string]any{"type": "tool_use"}}})
	var unsupported *UnsupportedRequest
	if !errors.As(err, &unsupported) {
		t.Fatalf("tool response was silently accepted: %v", err)
	}
	_, err = readText("responses", map[string]any{"status": "completed", "output": []any{
		map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": "partial"}}},
		map[string]any{"type": "function_call"},
	}})
	if !errors.As(err, &unsupported) {
		t.Fatalf("partial text and tool response was silently accepted: %v", err)
	}
	_, err = readText("responses", map[string]any{"status": "completed", "output": []any{
		map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": "hello", "annotations": []any{map[string]any{"type": "citation"}}}}},
	}})
	if !errors.As(err, &unsupported) {
		t.Fatalf("citation response was silently accepted: %v", err)
	}
	_, err = readText("chat", map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "possibly partial"}}}})
	if !errors.As(err, &unsupported) {
		t.Fatalf("unterminated response was silently accepted: %v", err)
	}
	_, err = encode("messages", "native", []turn{{Role: "user", Content: "hi"}, {Role: "system", Content: "late"}}, 32)
	if !errors.As(err, &unsupported) {
		t.Fatalf("late system instruction was silently reordered: %v", err)
	}
	_, _, err = readTurns("chat", map[string]any{"model": "coding", "messages": []any{
		map[string]any{"role": "assistant", "content": "hi", "tool_calls": []any{map[string]any{"id": "tool"}}},
	}})
	if !errors.As(err, &unsupported) {
		t.Fatalf("tool call was silently dropped: %v", err)
	}
	converted := decode("chat", "coding", "hello", map[string]any{
		"id": "msg_fixture", "usage": map[string]any{"input_tokens": float64(5), "output_tokens": float64(2)},
	})
	usage := converted["usage"].(map[string]any)
	if converted["id"] != "msg_fixture" || usage["prompt_tokens"] != int64(5) || usage["total_tokens"] != int64(7) {
		t.Fatalf("observed id or usage was lost: %+v", converted)
	}
}

func TestProxyOutageNeedsExplicitDecision(t *testing.T) {
	directCalls := 0
	direct := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		directCalls++
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "local"}}}})
	}))
	defer direct.Close()
	snapshot := Snapshot{Version: 1, Selectors: map[string]Selector{"coding": {Targets: []string{"direct/model"}}},
		Targets: map[string]Target{"direct/model": {Model: "model", Dialect: "chat", BaseURL: direct.URL, APIKey: "fixture"}}}
	status := http.StatusServiceUnavailable
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/client-snapshot" {
			_ = json.NewEncoder(w).Encode(snapshot)
			return
		}
		w.WriteHeader(status)
	}))
	defer gateway.Close()
	client, err := New(gateway.URL, "project-key", filepath.Join(t.TempDir(), "snapshot.json"), func(string, string) []string { return []string{"direct/model"} })
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}}
	_, err = client.Call(context.Background(), "chat", "coding", input)
	var call *CallError
	if !errors.As(err, &call) || call.Status != status || directCalls != 0 {
		t.Fatalf("gateway 503 was replayed: %v, %d direct", err, directCalls)
	}
	client.IsGatewayUnavailable = func(err error) bool { var call *CallError; return errors.As(err, &call) && call.Status == 503 }
	answer, err := client.Call(context.Background(), "chat", "coding", input)
	if err != nil || answer["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)["content"] != "local" {
		t.Fatalf("explicit outage did not use local target: %+v %v", answer, err)
	}
	status = http.StatusUnauthorized
	_, err = client.Call(context.Background(), "chat", "coding", input)
	if !errors.As(err, &call) || call.Status != status || directCalls != 1 {
		t.Fatalf("gateway 401 used local target: %v, %d direct", err, directCalls)
	}
	client.IsGatewayUnavailable = func(error) bool { return true }
	_, err = client.Stream(context.Background(), "chat", "coding", input)
	if !errors.As(err, &call) || call.Status != status || directCalls != 1 {
		t.Fatalf("gateway 401 opened a direct stream: %v, %d direct", err, directCalls)
	}
}

// The gateway suite runs this opt-in contract twice: once to save its real
// snapshot, then after its HTTP listener closes to prove direct fallback.
func TestConfiguredGatewayE2E(t *testing.T) {
	url := os.Getenv("LLMGW_SDK_E2E_URL")
	if url == "" {
		t.Skip("requires the gateway SDK contract fixture")
	}
	key := os.Getenv("LLMGW_SDK_E2E_KEY")
	cache := os.Getenv("LLMGW_SDK_E2E_CACHE")
	client, err := New(url, key, cache, func(string, string) []string { return []string{"two/fixture"} })
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("LLMGW_SDK_E2E_MODE") == "prime" {
		if err := client.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		return
	}
	if os.Getenv("LLMGW_SDK_E2E_MODE") == "stream" {
		stream, err := client.Stream(context.Background(), "chat", "coding", map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}, "max_tokens": 64})
		if err != nil {
			t.Fatal(err)
		}
		defer stream.Close()
		var text strings.Builder
		finished := false
		for {
			event, err := stream.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			if event.Data == "[DONE]" {
				finished = true
			}
			for _, item := range listOf(objectOf(event.Data)["choices"]) {
				text.WriteString(stringOf(objectOf(objectOf(item)["delta"])["content"]))
			}
		}
		if !finished || text.String() != "direct-ok" {
			t.Fatal("saved direct stream did not complete with the expected text")
		}
		return
	}
	result, err := client.Call(context.Background(), "chat", "coding", map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}})
	if err != nil {
		t.Fatal(err)
	}
	choices, ok := result["choices"].([]any)
	if !ok || len(choices) != 1 || choices[0].(map[string]any)["message"].(map[string]any)["content"] != "direct-ok" {
		t.Fatal("saved snapshot did not produce a direct answer")
	}
}
