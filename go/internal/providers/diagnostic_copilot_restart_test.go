package providers

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	core "github.com/kayiik/llmgw-core"
	coreext "github.com/kayiik/llmgw-core/extension"
)

// This fixture verifies that a saved Copilot model declaring /responses is
// translated by the Gateway from Chat to Responses and dispatched to the
// daemon with X-Surface: responses.
func TestDiagnosticCopilotResponsesModelAfterDaemonRestart(t *testing.T) {
	const model = "responses-only-fixture"
	const reply = `{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fixture answer"}]}],"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}`
	seen := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		surface := r.Header.Get(coreext.HeaderSurface)
		seen <- surface
		w.Header().Set("Content-Type", core.ContentTypeJSON)
		if surface != string(core.ModelSurfaceResponses) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"expected X-Surface: responses from Gateway"}`)
			return
		}
		_, _ = io.WriteString(w, reply)
	}))
	defer server.Close()
	client, err := coreext.NewClient(coreext.Config{BaseURL: server.URL, Secret: "synthetic", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	provider := coreext.NewProviderWithModelLookup(client,
		coreext.ProviderInfo{ID: "github_copilot", Surfaces: []core.ModelSurface{core.ModelSurfaceChatCompletions}},
		func(name string) (core.ModelInfo, bool) {
			return core.ModelInfo{ID: model, SupportedAPIs: []string{"/responses"}}, name == model
		})
	request := core.Request{Surface: core.ModelSurfaceChatCompletions, Model: model,
		Body: []byte(`{"messages":[{"role":"user","content":"fixture question"}]}`), ContentType: core.ContentTypeJSON}
	prepared, err := core.PrepareCall(context.Background(), provider, request, core.CallPreparationOptions{AllowAdaptation: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := core.PlanPreparedCall(prepared.Description(), core.CallPolicy{AllowAdaptation: true}); err != nil {
		t.Fatal(err)
	}
	answer, err := prepared.Invoke(context.Background(), nil)
	surface := "no daemon dispatch"
	select {
	case surface = <-seen:
	case <-time.After(2 * time.Second):
	}
	if err != nil || surface != string(core.ModelSurfaceResponses) || !strings.Contains(string(answer.Body), "fixture answer") {
		t.Fatal(fmt.Sprintf("cached catalog + daemon: surface=%s, err=%v, body=%s", surface, err, answer.Body))
	}
}
