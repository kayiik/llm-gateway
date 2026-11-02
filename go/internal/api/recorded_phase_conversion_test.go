package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	translate "github.com/kayiik/llm-translate"
)

func TestRecordedCodexFinalAnswerProjectsToChatStream(t *testing.T) {
	path := filepath.Join("..", "..", "..", "test", "integration", "fixtures", "recorded-upstream-bundle.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Extension struct {
			Codex struct {
				SSE string `json:"responses_sse"`
			} `json:"openai_codex"`
		} `json:"extension"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	var events []string
	for _, line := range strings.Split(fixture.Extension.Codex.SSE, "\n") {
		if strings.HasPrefix(line, "data: {") {
			events = append(events, strings.TrimPrefix(line, "data: "))
		}
	}
	index := 0
	pull := func() (string, bool) {
		if index >= len(events) {
			return "", false
		}
		value := events[index]
		index++
		return value, true
	}
	var chunks []string
	result := translate.ResponsesSSEToOpenAIChunksObserved(pull, "fixture", func(chunk string) { chunks = append(chunks, chunk) }, translate.StreamObservationOptions{IncludeUsage: true})
	var text strings.Builder
	for _, raw := range chunks {
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(raw), &chunk); err != nil {
			t.Fatal(err)
		}
		for _, choice := range chunk.Choices {
			text.WriteString(choice.Delta.Content)
		}
	}
	if !result.Completed || result.Err != nil || text.String() != "CAPTURE_OK" {
		t.Fatalf("recorded final-answer conversion: completed=%t err=%v unknown=%v losses=%v text=%q", result.Completed, result.Err, result.Assessment.UnknownPaths, result.Assessment.Report.Losses, text.String())
	}
}
