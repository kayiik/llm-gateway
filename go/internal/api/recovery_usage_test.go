package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"
	"llmgw/internal/providers"
	"llmgw/internal/router"
)

func TestStreamUsageEstimateIsIndependentOfFragmentation(t *testing.T) {
	for _, text := range []string{"test", "Hello there", "é你好🙂abc", `{"argument":"value"}`} {
		whole := newStreamUsage("fixture", "model", nil, nil, time.Now(), 0)
		whole.streamedText(text)
		pieces := newStreamUsage("fixture", "model", nil, nil, time.Now(), 0)
		for _, r := range text {
			pieces.streamedText(string(r))
		}
		_, a := whole.tokens()
		_, b := pieces.tokens()
		if a != b {
			t.Errorf("%q: whole=%d fragmented=%d", text, a, b)
		}
	}
}

func TestVerificationPrefersFreeEvidenceOverFamilyNames(t *testing.T) {
	for _, tc := range []struct {
		rows []providers.ModelInfo
		want string
	}{
		{[]providers.ModelInfo{{ID: "mimo-paid-fixture"}, {ID: "fixture-free"}}, "fixture-free"},
		{[]providers.ModelInfo{{ID: "nemotron-free"}, {ID: "declared", Free: true}}, "declared"},
		{[]providers.ModelInfo{{ID: "embedding-free", SupportedSurfaces: []string{"/v1/embeddings"}}, {ID: "chat-free", SupportedSurfaces: []string{"/v1/chat/completions"}}}, "chat-free"},
	} {
		if got := selectVerificationModel(tc.rows, true); got != tc.want {
			t.Errorf("selected %q, want %q", got, tc.want)
		}
	}
}

func TestVerificationUsesStoredCredentialForModelSelection(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	iam.ResetForTests()
	providers.ResetProviders()
	old := *config.Get()
	t.Cleanup(func() {
		iam.ResetForTests()
		providers.ResetProviders()
		config.Update(func(s *config.Settings) { *s = old })
	})
	var selected string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/models" {
			_, _ = w.Write([]byte(`{"data":[{"id":"flash-paid-fixture"},{"id":"fixture-free"}]}`))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		selected, _ = body["model"].(string)
		_, _ = w.Write([]byte(`{"id":"fixture","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
	}))
	defer upstream.Close()
	config.Update(func(s *config.Settings) {
		s.CredentialEncryptionKey = base64.StdEncoding.EncodeToString(make([]byte, 32))
		s.Providers = map[string]*config.ProviderConfig{"fixture": {Type: "openai_compatible", BaseURL: upstream.URL}}
		s.Policies.Defaults = config.ProviderPolicy{}
		s.Policies.Overrides = map[string]config.ProviderPolicy{}
	})
	if _, err := iam.PutSystemProviderConnection("fixture", providers.CredentialKindAPIKey, "fixture-secret"); err != nil {
		t.Fatal(err)
	}
	result := runProviderVerify("fixture", "", nil)
	if result["success"] != true || selected != "flash-paid-fixture" {
		t.Fatalf("success=%v selected=%q, want keyed selection", result["success"], selected)
	}
}

func TestNativeMessagesNonstreamAccountingIncludesCacheInput(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	iam.ResetForTests()
	router.ResetSavingsState()
	old := *config.Get()
	t.Cleanup(func() {
		iam.ResetForTests()
		router.ResetSavingsState()
		config.Update(func(s *config.Settings) { *s = old })
	})
	config.Update(func(s *config.Settings) { s.Savings.Enabled = false })
	for index, tc := range []struct {
		input, read, write any
		want               int64
	}{
		{json.Number("12"), json.Number("3000"), json.Number("200"), 3212},
		{json.Number("0"), json.Number("0"), json.Number("0"), 0},
		{json.Number("9007199254740993"), json.Number("2"), json.Number("1"), 9007199254740996},
	} {
		name := strings.Repeat("x", index+1)
		principal := &config.Principal{RequestID: name}
		usage := map[string]any{"input_tokens": tc.input, "cache_read_input_tokens": tc.read, "cache_creation_input_tokens": tc.write, "output_tokens": 3}
		recordFromResponse("anthropic.messages", name, &router.Target{Provider: "fixture", Model: "fixture"}, principal, map[string]any{"usage": usage}, 0)
		db, err := iam.DB()
		if err != nil {
			t.Fatal(err)
		}
		var input int64
		if err := db.QueryRow(`SELECT input_tokens FROM usage_events WHERE request_id=?`, name).Scan(&input); err != nil {
			t.Fatal(err)
		}
		if input != tc.want {
			t.Errorf("input=%d want=%d", input, tc.want)
		}
	}
}

func TestNativeMessagesInvalidCacheInputCannotWrapIntoUsage(t *testing.T) {
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	iam.ResetForTests()
	t.Cleanup(iam.ResetForTests)
	for _, cache := range []any{
		json.Number("-1"), json.Number("9223372036854775807"),
		json.Number("9223372036854775808"), json.Number("-18446744073709551616"),
		json.Number("1.5"), float64(9223372036854775808.0),
	} {
		recordFromResponse("anthropic.messages", "fixture", &router.Target{Provider: "fixture", Model: "fixture"}, &config.Principal{}, map[string]any{"usage": map[string]any{"input_tokens": 2, "cache_read_input_tokens": cache, "output_tokens": 0}}, 0)
	}
	db, err := iam.DB()
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage_events`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid usage rows=%d err=%v", count, err)
	}
}

func TestNativeUsageCountsPreserveExactIntegers(t *testing.T) {
	for _, tc := range []struct {
		value any
		want  int64
		valid bool
	}{
		{nil, 0, true}, {json.Number("0"), 0, true}, {json.Number("0.0e1000000"), 0, true},
		{json.Number("42.0"), 42, true}, {json.Number("4.2e1"), 42, true},
		{json.Number("9007199254740993.0"), 9007199254740993, true},
		{json.Number("9007199254740992.1"), 0, false},
		{json.Number("1e-1000000"), 0, false}, {json.Number("1e1000000"), 0, false},
		{json.Number("1.5"), 0, false}, {"42", 0, false},
	} {
		got, valid := nativeUsageCount(tc.value)
		if valid != tc.valid || (valid && int64(got) != tc.want) {
			t.Errorf("count(%v)=%d/%v want=%d/%v", tc.value, got, valid, tc.want, tc.valid)
		}
	}
}
