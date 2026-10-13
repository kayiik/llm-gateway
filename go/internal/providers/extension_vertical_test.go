package providers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llmgw/internal/config"

	"github.com/kayiik/llm-provider-auth/tokenstore"
	core "github.com/kayiik/llmgw-core"
	"github.com/kayiik/llmgw-core/oauthflow"
)

// useExtensions publishes extensions as the gateway's until the test ends,
// as the API layer publishes the ones gateway.db stores.
func useExtensions(t *testing.T, extensions ...config.Extension) {
	t.Helper()
	published := map[string]config.Extension{}
	for _, extension := range extensions {
		published[extension.ID] = extension
	}
	previous := config.Get().Extensions
	config.Update(func(s *config.Settings) { s.Extensions = published })
	t.Cleanup(func() { config.Update(func(s *config.Settings) { s.Extensions = previous }) })
}

// extensionDaemon serves mux as the companion daemon of the gateway's only
// extension, which admits only requests that carry the extension's shared
// secret, test-secret.
func extensionDaemon(t *testing.T, mux *http.ServeMux) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-secret" {
			t.Errorf("%s %s: Authorization = %q, want the shared secret", r.Method, r.URL.Path, got)
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	useExtensions(t, config.Extension{ID: "fixture-daemon", URL: server.URL, Secret: "test-secret"})
}

func writeExtensionJSON(t *testing.T, w http.ResponseWriter, status int, value any) {
	t.Helper()
	w.Header().Set("Content-Type", core.ContentTypeJSON)
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Error(err)
	}
}

func TestExtensionVerticalServesThroughTheDaemon(t *testing.T) {
	const reply = `{"choices":[{"message":{"content":"hello from extension"}}]}`
	mux := http.NewServeMux()
	mux.HandleFunc("POST /extension/v1/openai_codex/invoke", func(w http.ResponseWriter, r *http.Request) {
		for header, want := range map[string]string{
			"X-Surface":          string(core.ModelSurfaceChatCompletions),
			"X-Model":            "gpt-test",
			"Content-Type":       core.ContentTypeJSON,
			"X-Credential-Token": "access-1",
		} {
			if got := r.Header.Get(header); got != want {
				t.Errorf("invoke %s = %q, want %q", header, got, want)
			}
		}
		w.Header().Set("Content-Type", core.ContentTypeJSON)
		_, _ = io.WriteString(w, reply)
	})
	mux.HandleFunc("POST /extension/v1/openai_codex/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", core.ContentTypeEventStream)
		flusher := w.(http.Flusher)
		for _, record := range []string{"data: chunk-1\n\n", ": keepalive\n\n", "data: chunk-2\n\n"} {
			_, _ = io.WriteString(w, record)
			flusher.Flush()
		}
	})
	mux.HandleFunc("GET /extension/v1/openai_codex/models", func(w http.ResponseWriter, r *http.Request) {
		writeExtensionJSON(t, w, http.StatusOK, map[string]any{
			"models": []core.ModelInfo{{ID: "gpt-test", DisplayName: "GPT Test"}},
		})
	})
	mux.HandleFunc("POST /extension/v1/openai_codex/refresh", func(w http.ResponseWriter, r *http.Request) {
		var refresh struct {
			Record tokenstore.Record `json:"record"`
		}
		if err := json.NewDecoder(r.Body).Decode(&refresh); err != nil || refresh.Record.RefreshToken != "old-refresh" {
			t.Errorf("refresh request = %v, %v", refresh.Record, err)
		}
		writeExtensionJSON(t, w, http.StatusOK, map[string]any{
			"record": tokenstore.Record{AccessToken: "refreshed-access", RefreshToken: "refreshed-refresh"},
		})
	})
	extensionDaemon(t, mux)

	vertical := (&Runtime{}).extensionCoreVertical(ExtensionTypeCodex)
	provider, err := vertical.provider(config.Get(), "instance")
	if err != nil {
		t.Fatal(err)
	}
	wantSurfaces := []core.ModelSurface{core.ModelSurfaceChatCompletions, core.ModelSurfaceResponses}
	if got := provider.NativeSurfaces("gpt-test"); !slices.Equal(got, wantSurfaces) {
		t.Errorf("native surfaces = %v, want %v", got, wantSurfaces)
	}
	request := core.Request{
		Surface:     core.ModelSurfaceChatCompletions,
		Model:       "gpt-test",
		Body:        []byte(`{"messages":[{"role":"user","content":"hi"}]}`),
		ContentType: core.ContentTypeJSON,
		Credential:  &core.Credential{Token: "access-1"},
	}

	resp, err := provider.Invoke(context.Background(), request)
	if err != nil || string(resp.Body) != reply {
		t.Fatalf("invoke = %s, %v", resp.Body, err)
	}

	stream, err := provider.Stream(context.Background(), request)
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}
	defer stream.Close()
	var frames []string
	for {
		frame, err := stream.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("stream frame error: %v", err)
		}
		frames = append(frames, string(frame))
	}
	// The keepalive carries no data, so the stream skips it.
	if want := []string{"data: chunk-1\n\n", "data: chunk-2\n\n"}; !slices.Equal(frames, want) {
		t.Errorf("frames = %q, want %q", frames, want)
	}

	models, err := provider.ListModels(context.Background(), nil)
	if err != nil || len(models) != 1 || models[0].ID != "gpt-test" {
		t.Errorf("models = %+v, %v", models, err)
	}

	refresh := vertical.refresh(config.Get(), "instance")
	refreshed, err := refresh(context.Background(), tokenstore.Record{AccessToken: "old-access", RefreshToken: "old-refresh"})
	if err != nil || refreshed.AccessToken != "refreshed-access" {
		t.Errorf("refresh = %v, %v", refreshed, err)
	}

	// A surface off the list fails before it reaches the daemon, whose mux
	// has no route for it, even one the daemon serves for another provider.
	_, err = provider.Invoke(context.Background(), core.Request{Surface: core.ModelSurfaceAudioSpeech, Model: "gpt-test"})
	var surfaceError *core.SurfaceError
	if !errors.As(err, &surfaceError) {
		t.Errorf("speech error = %v, want a surface error", err)
	}
}

// Each provider type lists the surfaces the daemon serves for it, which are
// the only ones the gateway sends it.
func TestExtensionProvidersListTheSurfacesTheDaemonServes(t *testing.T) {
	useExtensions(t, config.Extension{ID: "unused", URL: "http://127.0.0.1:1", Secret: "test-secret"})
	chat := []core.ModelSurface{core.ModelSurfaceChatCompletions}
	for providerType, want := range map[string][]core.ModelSurface{
		ExtensionTypeCodex:          {core.ModelSurfaceChatCompletions, core.ModelSurfaceResponses},
		ExtensionTypeCopilot:        chat,
		ExtensionTypeAntigravity:    chat,
		ExtensionTypeZenAnonymous:   chat,
		ExtensionTypeEdgeTTS:        {core.ModelSurfaceAudioSpeech},
		ExtensionTypeAnthropicSetup: {core.ModelSurfaceMessages},
	} {
		provider, err := (&Runtime{}).extensionCoreVertical(providerType).provider(config.Get(), providerType)
		if err != nil {
			t.Fatal(err)
		}
		if got := provider.NativeSurfaces("model"); !slices.Equal(got, want) {
			t.Errorf("%s surfaces = %v, want %v", providerType, got, want)
		}
	}
}

func TestExtensionFacadeReachesTheDaemonThroughTheSharedClient(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /extension/v1/edge_tts/models", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Credential-Token"); got != "stored-access" {
			t.Errorf("models credential = %q, want the stored one", got)
		}
		writeExtensionJSON(t, w, http.StatusOK, map[string]any{"models": []core.ModelInfo{{ID: "en-US-Voice"}}})
	})
	mux.HandleFunc("POST /extension/v1/edge_tts/invoke", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-Surface") != string(core.ModelSurfaceAudioSpeech) || r.Header.Get("X-Model") != "en-US-Voice" ||
			r.Header.Get("Content-Type") != core.ContentTypeJSON || string(body) != `{"input":"hello"}` {
			t.Errorf("synthesize request: surface %q, model %q, content type %q, body %q",
				r.Header.Get("X-Surface"), r.Header.Get("X-Model"), r.Header.Get("Content-Type"), body)
		}
		if got := r.Header.Get("X-Credential-Token"); got != "stored-access" {
			t.Errorf("synthesize credential = %q, want the stored one", got)
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = io.WriteString(w, "mp3-bytes")
	})
	extensionDaemon(t, mux)

	store := core.NewMemoryCredentialStore()
	if _, err := store.Save(context.Background(), "tts-key", tokenstore.Record{AccessToken: "stored-access", TokenType: "Bearer"}); err != nil {
		t.Fatal(err)
	}
	store.BindShared("tts", "tts-key")
	rt := newRuntime(func(bool) (core.CredentialStore, error) { return store, nil })
	facade := rt.newExtensionFacade("tts", ExtensionTypeEdgeTTS, core.Caller{}, 0).(*ExtensionProviderFacade)

	models, _, err := facade.ListModelsWithError()
	if err != nil || len(models) != 1 || models[0].ID != "en-US-Voice" {
		t.Fatalf("models = %+v, %v", models, err)
	}
	audio, format, err := facade.Synthesize("en-US-Voice", "hello", "")
	if err != nil || string(audio) != "mp3-bytes" || format != "audio/mpeg" {
		t.Fatalf("synthesize = %q (%s), %v", audio, format, err)
	}
}

// Edge TTS is spoken through the daemon's audio speech surface, which takes
// an OpenAI speech request: the voice is its model, the text its input and
// the prosody rate its speed. The daemon refuses a body of bare text.
func TestExtensionSynthesisSendsAnOpenAISpeechRequest(t *testing.T) {
	type received struct {
		contentType, model string
		body               map[string]any
	}
	requests := make(chan received, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /extension/v1/edge_tts/invoke", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		requests <- received{contentType: r.Header.Get("Content-Type"), model: r.Header.Get("X-Model"), body: body}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = io.WriteString(w, "mp3-bytes")
	})
	extensionDaemon(t, mux)
	rt := newRuntime(func(bool) (core.CredentialStore, error) { return core.NewMemoryCredentialStore(), nil })
	facade := rt.newExtensionFacade("tts", ExtensionTypeEdgeTTS, core.Caller{}, 0).(*ExtensionProviderFacade)
	for rate, want := range map[string]map[string]any{
		"":     {"input": "Read <this> & that."},
		"+0%":  {"input": "Read <this> & that.", "speed": 1.0},
		"+25%": {"input": "Read <this> & that.", "speed": 1.25},
		"-50%": {"input": "Read <this> & that.", "speed": 0.5},
	} {
		audio, format, err := facade.Synthesize("en-US-Voice", "Read <this> & that.", rate)
		if err != nil || string(audio) != "mp3-bytes" || format != "audio/mpeg" {
			t.Fatalf("rate %q: synthesize = %q (%s), %v", rate, audio, format, err)
		}
		got := <-requests
		if got.contentType != core.ContentTypeJSON || got.model != "en-US-Voice" || !reflect.DeepEqual(got.body, want) {
			t.Errorf("rate %q: the daemon received %q, model %q, body %v; want %q, en-US-Voice, %v",
				rate, got.contentType, got.model, got.body, core.ContentTypeJSON, want)
		}
	}
}

// A provider the companion daemon serves sends its timeout with every
// invoke, stream and synthesis, so the daemon waits for the provider as long
// as the provider's settings say: its own timeout, a GitHub Copilot
// provider's setting, or the default.
func TestExtensionProvidersSendTheirTimeout(t *testing.T) {
	received := make(chan string, 8)
	mux := http.NewServeMux()
	for _, providerType := range []string{ExtensionTypeCodex, ExtensionTypeCopilot, ExtensionTypeEdgeTTS} {
		mux.HandleFunc("POST /extension/v1/"+providerType+"/invoke", func(w http.ResponseWriter, r *http.Request) {
			received <- providerType + " invoke " + r.Header.Get("X-Timeout")
			writeExtensionJSON(t, w, http.StatusOK, map[string]any{"choices": []any{}})
		})
		mux.HandleFunc("POST /extension/v1/"+providerType+"/stream", func(w http.ResponseWriter, r *http.Request) {
			received <- providerType + " stream " + r.Header.Get("X-Timeout")
			w.Header().Set("Content-Type", core.ContentTypeEventStream)
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		})
	}
	extensionDaemon(t, mux)
	own := 90.5
	previous := *config.Get()
	t.Cleanup(func() {
		config.Update(func(s *config.Settings) {
			s.Providers, s.GithubCopilotTimeoutSeconds = previous.Providers, previous.GithubCopilotTimeoutSeconds
		})
	})
	config.Update(func(s *config.Settings) {
		s.GithubCopilotTimeoutSeconds = 420
		s.Providers = map[string]*config.ProviderConfig{
			"codex-own":     {Type: "openai_compatible", RegistryID: ExtensionTypeCodex, Timeout: &own},
			"codex-default": {Type: "openai_compatible", RegistryID: ExtensionTypeCodex},
			"copilot":       {Type: ExtensionTypeCopilot},
			"tts":           {Type: ExtensionTypeEdgeTTS},
		}
	})
	runtime := newRuntime(func(bool) (core.CredentialStore, error) { return core.NewMemoryCredentialStore(), nil })
	facade := func(instance string) *ExtensionProviderFacade {
		t.Helper()
		settings := config.Get()
		provider, err := runtime.instantiate(settings, instance, settings.Providers[instance], core.Caller{})
		if err != nil {
			t.Fatal(err)
		}
		return provider.(*ExtensionProviderFacade)
	}
	messages := []Message{{"role": "user", "content": "hi"}}
	for instance, want := range map[string]string{"codex-own": "90.5", "codex-default": "300", "copilot": "420"} {
		chat := facade(instance)
		if _, err := chat.Complete("model", messages, nil); err != nil {
			t.Fatalf("%s invoke: %v", instance, err)
		}
		stream, err := chat.Stream("model", messages, nil)
		if err != nil {
			t.Fatalf("%s stream: %v", instance, err)
		}
		for _, ok := stream.Next(); ok; _, ok = stream.Next() {
		}
		_ = stream.Close()
		for _, operation := range []string{"invoke", "stream"} {
			if got, want := <-received, chat.providerID+" "+operation+" "+want; got != want {
				t.Errorf("%s: the daemon received %q, want %q", instance, got, want)
			}
		}
	}
	if _, _, err := facade("tts").Synthesize("voice", "hello", ""); err != nil {
		t.Fatal(err)
	}
	if got := <-received; got != "edge_tts invoke 300" {
		t.Errorf("the daemon received %q, want the default timeout on a synthesis", got)
	}
}

// The gateway's own controls, the fields prefixed "_", stay in the gateway,
// while the client's fields and the output limit the daemon reads go with
// the request, streamed or not.
func TestExtensionRequestsCarryNoGatewayControls(t *testing.T) {
	bodies := make(chan map[string]any, 2)
	record := func(r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		bodies <- body
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /extension/v1/openai_codex/invoke", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		writeExtensionJSON(t, w, http.StatusOK, map[string]any{"choices": []any{}})
	})
	mux.HandleFunc("POST /extension/v1/openai_codex/stream", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		w.Header().Set("Content-Type", core.ContentTypeEventStream)
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	})
	extensionDaemon(t, mux)
	facade := extensionFacadeFixture(t, ExtensionTypeCodex, "codex")
	messages := []Message{{"role": "user", "content": "hi"}}
	kw := Kwargs{
		"temperature": 0.5, "_max_output_tokens": 64,
		"_affinity_key": "session", "_fallback_timeout_ms": 1000, "_force_api_support": true,
	}

	if _, err := facade.Complete("gpt-test", messages, kw); err != nil {
		t.Fatal(err)
	}
	stream, err := facade.StreamContext(context.Background(), "gpt-test", messages, kw)
	if err != nil {
		t.Fatal(err)
	}
	_ = stream.Close()
	for _, operation := range []string{"complete", "stream"} {
		body := <-bodies
		if body["temperature"] != 0.5 || body["_max_output_tokens"] != float64(64) {
			t.Errorf("%s body %v lost a field the daemon reads", operation, body)
		}
		for field := range body {
			if strings.HasPrefix(field, "_") && field != "_max_output_tokens" {
				t.Errorf("%s body carries the gateway control %s", operation, field)
			}
		}
	}
}

// Codex, whose daemon serves Responses, gets a Responses request as it is,
// streamed or not, encrypted reasoning included and the gateway's own
// controls left out, and its answer and events come back as the daemon sent
// them. Copilot, whose daemon serves Responses only for some models, refuses
// them before anything is sent, so the router serves them over Chat.
func TestExtensionServesResponsesNativelyWhereTheDaemonDoes(t *testing.T) {
	const completed = `{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}`
	bodies := make(chan map[string]any, 2)
	record := func(r *http.Request) {
		if surface := r.Header.Get("X-Surface"); surface != string(core.ModelSurfaceResponses) {
			t.Errorf("%s surface = %q, want Responses", r.URL.Path, surface)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		bodies <- body
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /extension/v1/openai_codex/invoke", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		writeExtensionJSON(t, w, http.StatusOK, map[string]any{"id": "resp_1", "object": "response", "status": "completed", "output": []any{}})
	})
	mux.HandleFunc("POST /extension/v1/openai_codex/stream", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		w.Header().Set("Content-Type", core.ContentTypeEventStream)
		_, _ = io.WriteString(w, "event: response.completed\ndata: "+completed+"\n\n")
	})
	extensionDaemon(t, mux)
	ctx := context.Background()
	payload := map[string]any{
		"model": "codex/gpt-test", "_affinity_key": "session",
		"input": []any{map[string]any{"type": "reasoning", "encrypted_content": "opaque", "summary": []any{}}},
	}

	codex := extensionFacadeFixture(t, ExtensionTypeCodex, "codex")
	response, _, err := CompleteResponsesContext(ctx, codex, "gpt-test", payload)
	if err != nil || response["id"] != "resp_1" {
		t.Fatalf("response = %v, %v", response, err)
	}
	stream, _, err := StreamResponsesContext(ctx, codex, "gpt-test", payload)
	if err != nil {
		t.Fatal(err)
	}
	if event, more := stream.Next(); !more || event != completed {
		t.Errorf("event = %q (more %t), want the daemon's", event, more)
	}
	if _, more := stream.Next(); more || stream.Err() != nil {
		t.Errorf("stream after its terminal event: more %t, err %v", more, stream.Err())
	}
	_ = stream.Close()
	for range 2 {
		body := <-bodies
		input, _ := body["input"].([]any)
		if len(input) != 1 || body["_affinity_key"] != nil {
			t.Errorf("body = %v, want the request without the gateway's controls", body)
		}
	}

	copilot := extensionFacadeFixture(t, ExtensionTypeCopilot, "copilot")
	if _, _, err := CompleteResponsesContext(ctx, copilot, "gpt-test", payload); !errors.Is(err, ErrResponsesUnsupported) {
		t.Errorf("Copilot Responses error = %v, want the Chat fallback", err)
	}
	if _, _, err := StreamResponsesContext(ctx, copilot, "gpt-test", payload); !errors.Is(err, ErrResponsesUnsupported) {
		t.Errorf("Copilot Responses stream error = %v, want the Chat fallback", err)
	}
}

// The setup-token Anthropic provider, which the daemon serves over Messages
// alone, answers Messages natively: as they are, with the preamble the
// daemon reads but without the gateway's other controls, its answer keeping
// its numbers as written. Its Chat is refused before anything is sent and
// leaves an endpoint to its next member. No other provider the daemon serves
// answers Messages natively, and this one synthesizes no speech.
func TestExtensionServesMessagesNativelyWhereTheDaemonDoes(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /extension/v1/anthropic_setup_token/invoke", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Surface") != string(core.ModelSurfaceMessages) || r.Header.Get("X-Model") != "claude-test" {
			t.Errorf("surface %q, model %q", r.Header.Get("X-Surface"), r.Header.Get("X-Model"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["_llmgw_preamble"] != "policy" || body["_affinity_key"] != nil {
			t.Errorf("body = %v (%v), want the preamble without the gateway's other controls", body, err)
		}
		w.Header().Set("Content-Type", core.ContentTypeJSON)
		_, _ = io.WriteString(w, `{"id":"msg_1","type":"message","content":[],"usage":{"input_tokens":12}}`)
	})
	extensionDaemon(t, mux)
	setup := extensionProviderFixture(t, ExtensionTypeAnthropicSetup, "setup")
	if !SupportsAnthropicMessages(setup) {
		t.Fatalf("the setup-token facade %T does not answer Messages", setup)
	}
	if _, speech := AsSpeechSynthesizer(setup); speech {
		t.Error("the setup-token facade synthesizes speech")
	}
	payload := map[string]any{
		"model": "setup/claude-test", "max_tokens": 16, "_llmgw_preamble": "policy", "_affinity_key": "session",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}
	response, err := CompleteAnthropicMessagesContext(context.Background(), setup, "claude-test", payload)
	if err != nil || response["id"] != "msg_1" {
		t.Fatalf("response = %v, %v", response, err)
	}
	if usage, _ := response["usage"].(map[string]any); usage["input_tokens"] != json.Number("12") {
		t.Errorf("usage = %v, want its numbers as written", response["usage"])
	}
	_, err = setup.Complete("claude-test", []Message{{"role": "user", "content": "hi"}}, nil)
	if !IsInvocation(err) || UpstreamStatus(err) != 0 || InvocationRetryable(err) || !InvocationFailoverEligible(err) {
		t.Errorf("Chat error = %v, want one refused before it is sent", err)
	}

	for _, providerType := range []string{ExtensionTypeCodex, ExtensionTypeCopilot, ExtensionTypeEdgeTTS} {
		if SupportsAnthropicMessages((&Runtime{}).newExtensionFacade(providerType, providerType, core.Caller{}, 0)) {
			t.Errorf("%s answers Messages natively", providerType)
		}
	}
}

// publishedExtensions is settings holding extensions, as the API layer
// publishes them.
func publishedExtensions(extensions ...config.Extension) *config.Settings {
	published := map[string]config.Extension{}
	for _, ext := range extensions {
		published[ext.ID] = ext
	}
	return &config.Settings{Extensions: published}
}

// The requests to one extension share its client, which is replaced once
// the extension's address or secret changes, and dropped with the
// extension.
func TestExtensionClientsAreSharedUntilTheirExtensionChanges(t *testing.T) {
	rt := newRuntime(func(bool) (core.CredentialStore, error) { return core.NewMemoryCredentialStore(), nil })
	home := config.Extension{ID: "home", URL: "http://127.0.0.1:18888", Secret: "one"}
	office := config.Extension{ID: "office", URL: "http://127.0.0.1:18889", Secret: "one"}
	clientOf := func(settings *config.Settings, ext config.Extension) any {
		t.Helper()
		client, err := rt.extensionClient(settings, ext)
		if err != nil {
			t.Fatalf("client of %s: %v", ext.ID, err)
		}
		return client
	}
	first := clientOf(publishedExtensions(home, office), home)
	if again := clientOf(publishedExtensions(home, office), home); again != first {
		t.Fatalf("client of an unchanged extension = %p, want the shared %p", again, first)
	}
	if other := clientOf(publishedExtensions(home, office), office); other == first {
		t.Fatal("two extensions share a client")
	}
	home.Secret = "two"
	newSecret := clientOf(publishedExtensions(home, office), home)
	if newSecret == first {
		t.Fatal("the client outlived a secret change")
	}
	home.URL = "http://127.0.0.1:18890"
	newURL := clientOf(publishedExtensions(home, office), home)
	if newURL == newSecret {
		t.Fatal("the client outlived an address change")
	}

	// An address the client cannot use is a configuration error wherever
	// the client is needed. It names the extension and not the address.
	broken := home
	broken.URL = "http://owner:not-a-secret@127.0.0.1:18890"
	refused := func(where string, err error) {
		t.Helper()
		if !IsConfig(err) || !strings.Contains(err.Error(), "'home'") || strings.Contains(err.Error(), "not-a-secret") {
			t.Fatalf("%s for an unusable address: %v, want a configuration error naming the extension", where, err)
		}
	}
	_, err := rt.extensionClient(publishedExtensions(broken, office), broken)
	refused("client", err)
	_, err = rt.extensionCoreVertical(ExtensionTypeCodex).provider(publishedExtensions(broken), "codex")
	refused("provider", err)
	useExtensions(t, broken)
	driver, err := rt.OAuthDriver(ExtensionTypeCodex, "codex", oauthflow.MethodDevice)
	if err != nil {
		t.Fatal(err)
	}
	_, err = driver.Start(context.Background(), oauthflow.StartRequest{Method: oauthflow.MethodDevice})
	refused("sign-in", err)

	// The failed rebuild leaves the last client in place, and an extension
	// the settings no longer have loses its own.
	if again := clientOf(publishedExtensions(home), home); again != newURL {
		t.Fatalf("client after an unusable address = %p, want the shared %p", again, newURL)
	}
	rt.extensions.mu.Lock()
	_, kept := rt.extensions.clients["office"]
	rt.extensions.mu.Unlock()
	if kept {
		t.Fatal("the client of a removed extension was kept")
	}

	// An extension the gateway cannot use, such as one whose secret does
	// not decrypt, is a configuration error that says why.
	unusable := config.Extension{ID: "attic", URL: "http://127.0.0.1:18891", Unusable: "its secret does not decrypt"}
	if _, err := rt.extensionClient(publishedExtensions(unusable), unusable); !IsConfig(err) ||
		!strings.Contains(err.Error(), "its secret does not decrypt") {
		t.Fatalf("client of an unusable extension: %v", err)
	}
}

// A provider the companion daemon serves is served by the extension its
// configuration names, or else by the gateway's only extension. Any other
// case is a configuration error that names the provider and says what to
// do.
func TestProvidersResolveTheExtensionThatServesThem(t *testing.T) {
	home := config.Extension{ID: "home", URL: "http://127.0.0.1:18888", Secret: "s"}
	office := config.Extension{ID: "office", URL: "http://127.0.0.1:18889", Secret: "s"}
	naming := func(named string, extensions ...config.Extension) *config.Settings {
		settings := publishedExtensions(extensions...)
		settings.Providers = map[string]*config.ProviderConfig{"copilot": {Type: ExtensionTypeCopilot, Extension: named}}
		return settings
	}
	for name, test := range map[string]struct {
		settings *config.Settings
		provider string
		want     string
		problem  []string
	}{
		"named":                {naming("office", home, office), "copilot", "office", nil},
		"the only one":         {naming("", home), "copilot", "home", nil},
		"named, the only one":  {naming("home", home), "copilot", "home", nil},
		"not configured yet":   {naming("", office), "codex", "office", nil},
		"none":                 {naming(""), "copilot", "", []string{"provider 'copilot'", "no extension is configured"}},
		"no settings":          {nil, "copilot", "", []string{"provider 'copilot'", "no extension is configured"}},
		"several, none named":  {naming("", home, office), "copilot", "", []string{"provider 'copilot'", "2 extensions are configured", "choose which extension serves it"}},
		"named, not available": {naming("garage", home), "copilot", "", []string{"provider 'copilot'", "extension 'garage' is not configured"}},
	} {
		got, err := ExtensionFor(test.settings, test.provider)
		if test.want != "" {
			if err != nil || got.ID != test.want {
				t.Errorf("%s: extension %q err=%v, want %q", name, got.ID, err, test.want)
			}
			continue
		}
		if !IsConfig(err) {
			t.Errorf("%s: err=%v, want a configuration error", name, err)
			continue
		}
		for _, part := range test.problem {
			if !strings.Contains(err.Error(), part) {
				t.Errorf("%s: %q does not say %q", name, err, part)
			}
		}
	}
}

// What keeps a provider from its extension is its configuration issue,
// which the console shows as setup to complete, and its catalog is not read
// meanwhile.
func TestAProviderWithoutAnExtensionHasAConfigurationIssue(t *testing.T) {
	configured := config.Get().Providers
	config.Update(func(s *config.Settings) {
		s.Providers = map[string]*config.ProviderConfig{
			"copilot": {Type: ExtensionTypeCopilot},
			"plain":   {Type: "openai_compatible", BaseURL: "http://127.0.0.1:9/v1"},
		}
	})
	t.Cleanup(func() { config.Update(func(s *config.Settings) { s.Providers = configured }) })
	useExtensions(t)
	if issue := ProviderConfigurationIssue("copilot"); !strings.Contains(issue, "no extension is configured") {
		t.Fatalf("issue without an extension = %q", issue)
	}
	if issue := ProviderConfigurationIssue("plain"); issue != "" {
		t.Fatalf("a provider no daemon serves has the issue %q", issue)
	}
	rt := newRuntime(func(bool) (core.CredentialStore, error) { return core.NewMemoryCredentialStore(), nil })
	_, _, err := rt.ListProviderModelsForPrincipalWithError("copilot", gatewayCaller())
	if code, detail, _ := CatalogFailure(err); code != "catalog_configuration_incomplete" || !strings.Contains(detail, "no extension is configured") {
		t.Fatalf("catalog without an extension: %s %q", code, detail)
	}
	useExtensions(t, config.Extension{ID: "home", URL: "http://127.0.0.1:18888", Secret: "s"})
	if issue := ProviderConfigurationIssue("copilot"); issue != "" {
		t.Fatalf("issue with the only extension = %q", issue)
	}
}

// The type "extension" stood for the companion daemon without naming a
// provider it serves. A provider still configured with it is refused with a
// configuration error that says what to configure instead.
func TestTheRetiredExtensionTypeIsAConfigurationError(t *testing.T) {
	configured := config.Get().Providers
	config.Update(func(s *config.Settings) {
		s.Providers = map[string]*config.ProviderConfig{"daemon": {Type: "extension"}}
	})
	t.Cleanup(func() { config.Update(func(s *config.Settings) { s.Providers = configured }) })
	useExtensions(t, config.Extension{ID: "home", URL: "http://127.0.0.1:18888", Secret: "s"})
	if served := CompanionDaemonProviders(config.Get()); len(served) != 0 {
		t.Fatalf("the daemon serves %v, want none", served)
	}
	rt := newRuntime(func(bool) (core.CredentialStore, error) { return core.NewMemoryCredentialStore(), nil })
	_, err := rt.GetProvider("daemon")
	if !IsConfig(err) || !strings.Contains(err.Error(), "type 'extension'") || !strings.Contains(err.Error(), "github_copilot") {
		t.Fatalf("provider of the retired type: %v", err)
	}
	if issue := ProviderConfigurationIssue("daemon"); !strings.Contains(issue, "type 'extension'") {
		t.Fatalf("issue of the retired type = %q", issue)
	}
}

// A request after an extension moves reaches its new address, through every
// path that keeps a client, without a restart: the provider the core
// Runtime built, and the facade's catalog. The replaced client's idle
// connections are closed.
func TestARequestAfterAnExtensionMovesReachesItsNewAddress(t *testing.T) {
	daemon := func(calls *atomic.Int32) http.Handler {
		mux := http.NewServeMux()
		mux.HandleFunc("POST /extension/v1/openai_codex/invoke", func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			writeExtensionJSON(t, w, http.StatusOK, map[string]any{"choices": []any{}})
		})
		mux.HandleFunc("GET /extension/v1/openai_codex/models", func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			writeExtensionJSON(t, w, http.StatusOK, map[string]any{"models": []core.ModelInfo{{ID: "gpt-test"}}})
		})
		return mux
	}
	var oldCalls, newCalls atomic.Int32
	closed := make(chan struct{}, 16)
	old := httptest.NewUnstartedServer(daemon(&oldCalls))
	old.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			closed <- struct{}{}
		}
	}
	old.Start()
	defer old.Close()
	moved := httptest.NewServer(daemon(&newCalls))
	defer moved.Close()
	useExtensions(t, config.Extension{ID: "home", URL: old.URL, Secret: "test-secret"})
	facade := extensionFacadeFixture(t, ExtensionTypeCodex, "codex")
	messages := []Message{{"role": "user", "content": "hi"}}
	serve := func() {
		t.Helper()
		if _, err := facade.Complete("gpt-test", messages, nil); err != nil {
			t.Fatal(err)
		}
		if models, _, err := facade.ListModelsWithError(); err != nil || len(models) != 1 {
			t.Fatalf("models = %+v, %v", models, err)
		}
	}
	serve()
	if oldCalls.Load() != 2 || len(closed) != 0 {
		t.Fatalf("before the move: old address answered %d, %d connections closed", oldCalls.Load(), len(closed))
	}
	// As the API layer publishes the extension's new address.
	config.Update(func(s *config.Settings) {
		s.Extensions = map[string]config.Extension{"home": {ID: "home", URL: moved.URL, Secret: "test-secret"}}
	})
	serve()
	if oldCalls.Load() != 2 || newCalls.Load() != 2 {
		t.Fatalf("after the move: old address answered %d, new %d; want only the new one", oldCalls.Load(), newCalls.Load())
	}
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the replaced client kept its idle connection to the old address")
	}
}

// A sign-in runs through the extension its start named, from its start to
// its completion, whatever serves its provider meanwhile. One that names
// none runs through the extension that serves its provider.
func TestExtensionSignInRunsThroughTheExtensionItsStartNamed(t *testing.T) {
	steps := make(chan string, 8)
	daemon := func(name string) *httptest.Server {
		mux := http.NewServeMux()
		mux.HandleFunc("POST /extension/v1/openai_codex/oauth/start", func(w http.ResponseWriter, r *http.Request) {
			steps <- name + " start"
			writeExtensionJSON(t, w, http.StatusOK, map[string]any{"authorization": oauthflow.Authorization{
				UserCode: "USER-1", VerificationURI: "https://example.test/verify", Secrets: oauthflow.Secrets{DeviceCode: "device-1"},
			}})
		})
		mux.HandleFunc("POST /extension/v1/openai_codex/oauth/poll", func(w http.ResponseWriter, r *http.Request) {
			steps <- name + " poll"
			writeExtensionJSON(t, w, http.StatusOK, map[string]any{"result": oauthflow.PollResult{Status: oauthflow.PollPending}})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		return server
	}
	home, office := daemon("home"), daemon("office")
	useExtensions(t,
		config.Extension{ID: "home", URL: home.URL, Secret: "s"},
		config.Extension{ID: "office", URL: office.URL, Secret: "s"},
	)
	rt := newRuntime(func(bool) (core.CredentialStore, error) { return core.NewMemoryCredentialStore(), nil })
	driver, err := rt.OAuthDriver(ExtensionTypeCodex, "codex", oauthflow.MethodDevice)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	params := WithSignInExtension(map[string]string{"credential_kind": "oauth"}, "office")
	if SignInExtension(params) != "office" {
		t.Fatalf("params %v do not name the extension", params)
	}
	if _, err := driver.Start(ctx, oauthflow.StartRequest{Method: oauthflow.MethodDevice, Params: params}); err != nil {
		t.Fatal(err)
	}
	flow := oauthflow.Flow{Secrets: oauthflow.Secrets{DeviceCode: "device-1", Params: params}}
	if _, err := driver.(oauthflow.DeviceDriver).Poll(ctx, flow); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"office start", "office poll"} {
		if got := <-steps; got != want {
			t.Fatalf("the daemons saw %q, want %q", got, want)
		}
	}
	// Two extensions and none named: the provider has to choose.
	if _, err := driver.Start(ctx, oauthflow.StartRequest{Method: oauthflow.MethodDevice}); !IsConfig(err) ||
		!strings.Contains(err.Error(), "choose which extension serves it") {
		t.Fatalf("start naming no extension among several: %v", err)
	}
	// The extension the flow started through is gone.
	useExtensions(t, config.Extension{ID: "home", URL: home.URL, Secret: "s"})
	if _, err := driver.(oauthflow.DeviceDriver).Poll(ctx, flow); !IsConfig(err) || !strings.Contains(err.Error(), "'office'") {
		t.Fatalf("poll through a removed extension: %v", err)
	}
	if len(steps) != 0 {
		t.Fatalf("a refused step reached a daemon: %q", <-steps)
	}
}

func TestExtensionDaemonErrorsAreBounded(t *testing.T) {
	reason := strings.Repeat("the upstream refused the request ", 100)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /extension/v1/openai_codex/invoke", func(w http.ResponseWriter, r *http.Request) {
		writeExtensionJSON(t, w, http.StatusTooManyRequests, map[string]any{
			"error": map[string]any{"message": reason, "code": http.StatusTooManyRequests},
		})
	})
	extensionDaemon(t, mux)

	provider, err := (&Runtime{}).extensionCoreVertical(ExtensionTypeCodex).provider(config.Get(), "codex")
	if err != nil {
		t.Fatal(err)
	}
	_, err = provider.Invoke(context.Background(), core.Request{
		Surface: core.ModelSurfaceResponses, Model: "gpt-test", Body: []byte(`{}`), ContentType: core.ContentTypeJSON,
	})
	var providerError *core.ProviderError
	if !errors.As(err, &providerError) || core.ClassifyError(err).StatusCode != http.StatusTooManyRequests {
		t.Fatalf("daemon error = %v, want a provider error with the daemon's status", err)
	}
	if message := err.Error(); !strings.Contains(message, "the upstream refused the request") || len(message) > 1024 {
		t.Fatalf("daemon error message is %d bytes: %q", len(message), message)
	}
}

func TestExtensionOAuthDriverSignsInThroughTheDaemon(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /extension/v1/openai_codex/oauth/start", func(w http.ResponseWriter, r *http.Request) {
		var start map[string]any
		if err := json.NewDecoder(r.Body).Decode(&start); err != nil || start["method"] != string(oauthflow.MethodDevice) {
			t.Errorf("start request = %v, %v", start, err)
		}
		writeExtensionJSON(t, w, http.StatusOK, map[string]any{
			"authorization": oauthflow.Authorization{
				UserCode:        "USER-123",
				VerificationURI: "https://example.test/verify",
				Secrets:         oauthflow.Secrets{DeviceCode: "device-1"},
			},
		})
	})
	mux.HandleFunc("POST /extension/v1/openai_codex/oauth/poll", func(w http.ResponseWriter, r *http.Request) {
		var poll struct {
			Flow oauthflow.Flow `json:"flow"`
		}
		if err := json.NewDecoder(r.Body).Decode(&poll); err != nil || poll.Flow.Secrets.DeviceCode != "device-1" {
			t.Errorf("poll request did not carry the device code: %v", err)
		}
		writeExtensionJSON(t, w, http.StatusOK, map[string]any{
			"result": oauthflow.PollResult{Status: oauthflow.PollApproved, Record: tokenstore.Record{AccessToken: "device-access"}},
		})
	})
	mux.HandleFunc("POST /extension/v1/openai_codex/oauth/exchange", func(w http.ResponseWriter, r *http.Request) {
		var exchange struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&exchange); err != nil || exchange.Code != "code-1" {
			t.Errorf("exchange request = %+v, %v", exchange, err)
		}
		writeExtensionJSON(t, w, http.StatusOK, map[string]any{"record": tokenstore.Record{AccessToken: "code-access"}})
	})
	extensionDaemon(t, mux)

	driver, err := newRuntime(func(bool) (core.CredentialStore, error) {
		return core.NewMemoryCredentialStore(), nil
	}).OAuthDriver(ExtensionTypeCodex, "codex", oauthflow.MethodDevice)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	auth, err := driver.Start(ctx, oauthflow.StartRequest{Method: oauthflow.MethodDevice})
	if err != nil || auth.UserCode != "USER-123" || auth.VerificationURI != "https://example.test/verify" {
		t.Fatalf("start = %+v, %v", auth, err)
	}
	device, ok := driver.(oauthflow.DeviceDriver)
	if !ok {
		t.Fatal("the extension driver is not a device driver")
	}
	result, err := device.Poll(ctx, oauthflow.Flow{Secrets: auth.Secrets})
	if err != nil || result.Status != oauthflow.PollApproved || result.Record.AccessToken != "device-access" {
		t.Fatalf("poll = %v, %v", result.Status, err)
	}
	code, ok := driver.(oauthflow.CodeDriver)
	if !ok {
		t.Fatal("the extension driver is not a code driver")
	}
	record, err := code.Exchange(ctx, oauthflow.Flow{}, "code-1")
	if err != nil || record.AccessToken != "code-access" {
		t.Fatalf("exchange = %v, %v", record, err)
	}
}
