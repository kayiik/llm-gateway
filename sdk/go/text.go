package llmgwclient

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"strings"
	"time"
)

type turn struct{ Role, Content string }

func readTurns(dialect string, body map[string]any) ([]turn, int, error) {
	allowed := map[string]map[string]bool{
		"chat":      {"model": true, "messages": true, "max_tokens": true},
		"responses": {"model": true, "input": true, "max_output_tokens": true},
		"messages":  {"model": true, "messages": true, "system": true, "max_tokens": true},
	}[dialect]
	if allowed == nil {
		return nil, 0, &UnsupportedRequest{"unknown caller dialect"}
	}
	for key := range body {
		if !allowed[key] {
			return nil, 0, &UnsupportedRequest{"only plain text turns and output-token limits can be converted locally"}
		}
	}
	result := []turn{}
	if dialect == "messages" && body["system"] != nil {
		system, ok := body["system"].(string)
		if !ok {
			return nil, 0, &UnsupportedRequest{"only text system instructions can be converted"}
		}
		result = append(result, turn{"system", system})
	}
	var source any
	if dialect == "responses" {
		source = body["input"]
	} else {
		source = body["messages"]
	}
	if text, ok := source.(string); ok && dialect == "responses" {
		source = []any{map[string]any{"role": "user", "content": text}}
	}
	switch items := source.(type) {
	case []map[string]any:
		for _, item := range items {
			result = appendTurn(result, item)
		}
	case []any:
		for _, raw := range items {
			item, ok := raw.(map[string]any)
			if !ok {
				return nil, 0, &UnsupportedRequest{"only plain text turns can be converted"}
			}
			result = appendTurn(result, item)
		}
	default:
		return nil, 0, &UnsupportedRequest{"text messages must be a list"}
	}
	if len(result) == 0 {
		return nil, 0, &UnsupportedRequest{"at least one text turn is required"}
	}
	for _, item := range result {
		if item.Role == "" {
			return nil, 0, &UnsupportedRequest{"only plain text system, user, and assistant turns can be converted"}
		}
	}
	key := "max_tokens"
	if dialect == "responses" {
		key = "max_output_tokens"
	}
	limit := 0
	if value, found := body[key]; found {
		switch n := value.(type) {
		case int:
			limit = n
		case float64:
			if n == float64(int(n)) {
				limit = int(n)
			}
		}
		if limit <= 0 {
			return nil, 0, &UnsupportedRequest{"output-token limit must be a positive integer"}
		}
	}
	return result, limit, nil
}

func appendTurn(turns []turn, item map[string]any) []turn {
	for key := range item {
		if key != "role" && key != "content" {
			return append(turns, turn{})
		}
	}
	role, okRole := item["role"].(string)
	content, okContent := item["content"].(string)
	if !okRole || !okContent || (role != "system" && role != "user" && role != "assistant") {
		return append(turns, turn{})
	}
	return append(turns, turn{role, content})
}

func encode(dialect, model string, turns []turn, limit int) (map[string]any, error) {
	messages := make([]map[string]any, 0, len(turns))
	system := []string{}
	for index, item := range turns {
		if dialect == "messages" && item.Role == "system" {
			if index != 0 || len(system) != 0 {
				return nil, &UnsupportedRequest{"only one leading system instruction can be converted to Messages"}
			}
			system = append(system, item.Content)
			continue
		}
		messages = append(messages, map[string]any{"role": item.Role, "content": item.Content})
	}
	switch dialect {
	case "chat":
		out := map[string]any{"model": model, "messages": messages}
		if limit > 0 {
			out["max_tokens"] = limit
		}
		return out, nil
	case "responses":
		out := map[string]any{"model": model, "input": messages}
		if limit > 0 {
			out["max_output_tokens"] = limit
		}
		return out, nil
	case "messages":
		if len(messages) == 0 {
			return nil, &UnsupportedRequest{"Messages needs a user or assistant turn"}
		}
		if limit == 0 {
			limit = 1024
		}
		out := map[string]any{"model": model, "messages": messages, "max_tokens": limit}
		if len(system) > 0 {
			out["system"] = strings.Join(system, "\n")
		}
		return out, nil
	default:
		return nil, &UnsupportedRequest{"unknown target dialect"}
	}
}

func readText(dialect string, response map[string]any) (string, error) {
	var text string
	switch dialect {
	case "chat":
		choices, ok := response["choices"].([]any)
		if !ok || len(choices) != 1 {
			break
		}
		choice, ok := choices[0].(map[string]any)
		if !ok {
			break
		}
		if choice["finish_reason"] != "stop" {
			return "", &UnsupportedRequest{"target response includes unsupported completion semantics"}
		}
		message, ok := choice["message"].(map[string]any)
		if ok && message["tool_calls"] == nil && message["refusal"] == nil {
			text, ok = message["content"].(string)
			if ok {
				return text, nil
			}
		}
	case "messages":
		if response["stop_reason"] != "end_turn" {
			return "", &UnsupportedRequest{"target response includes unsupported completion semantics"}
		}
		parts, ok := response["content"].([]any)
		if !ok {
			break
		}
		for _, raw := range parts {
			part, ok := raw.(map[string]any)
			if !ok || part["type"] != "text" || !emptyOrMissing(part["citations"]) {
				return "", &UnsupportedRequest{"target response has non-text content"}
			}
			value, ok := part["text"].(string)
			if !ok {
				return "", &UnsupportedRequest{"target response has non-text content"}
			}
			text += value
		}
		return text, nil
	case "responses":
		if response["status"] != "completed" {
			return "", &UnsupportedRequest{"target response includes unsupported completion semantics"}
		}
		items, ok := response["output"].([]any)
		if !ok {
			if value, ok := response["output_text"].(string); ok {
				return value, nil
			}
			break
		}
		for _, raw := range items {
			item, ok := raw.(map[string]any)
			if !ok || item["type"] != "message" {
				return "", &UnsupportedRequest{"target response has non-text content"}
			}
			parts, ok := item["content"].([]any)
			if !ok {
				return "", &UnsupportedRequest{"target response has non-text content"}
			}
			for _, rawPart := range parts {
				part, ok := rawPart.(map[string]any)
				if !ok || part["type"] != "output_text" || !emptyOrMissing(part["annotations"]) {
					return "", &UnsupportedRequest{"target response has non-text content"}
				}
				value, ok := part["text"].(string)
				if !ok {
					return "", &UnsupportedRequest{"target response has non-text content"}
				}
				text += value
			}
		}
		if len(items) == 0 {
			return "", &UnsupportedRequest{"target response is not a plain text answer"}
		}
		if convenience, present := response["output_text"].(string); present && convenience != text {
			return "", &UnsupportedRequest{"target response text fields disagree"}
		}
		return text, nil
	}
	return "", &UnsupportedRequest{fmt.Sprintf("%s response is not a plain text answer", dialect)}
}

func decode(dialect, model, text string, sources ...map[string]any) map[string]any {
	source := map[string]any{}
	if len(sources) > 0 && sources[0] != nil {
		source = sources[0]
	}
	id, _ := source["id"].(string)
	if id == "" {
		var random [16]byte
		if _, err := rand.Read(random[:]); err == nil {
			id = "local_" + hex.EncodeToString(random[:])
		} else {
			id = fmt.Sprintf("local_%d", time.Now().UnixNano())
		}
	}
	created := time.Now().Unix()
	if n, valid := nonnegativeCount(source["created"]); valid {
		created = n
	} else if n, valid := nonnegativeCount(source["created_at"]); valid {
		created = n
	}
	var input, output int64
	usage, hasUsage := source["usage"].(map[string]any)
	if hasUsage {
		var validInput, validOutput bool
		input, validInput = nonnegativeCount(usage["input_tokens"])
		if !validInput {
			input, validInput = nonnegativeCount(usage["prompt_tokens"])
		}
		output, validOutput = nonnegativeCount(usage["output_tokens"])
		if !validOutput {
			output, validOutput = nonnegativeCount(usage["completion_tokens"])
		}
		hasUsage = validInput && validOutput && input <= math.MaxInt64-output
	}
	switch dialect {
	case "chat":
		answer := map[string]any{"id": id, "created": created, "object": "chat.completion", "model": model, "choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": text}, "finish_reason": "stop"}}}
		if hasUsage {
			answer["usage"] = map[string]any{"prompt_tokens": input, "completion_tokens": output, "total_tokens": input + output}
		}
		return answer
	case "messages":
		answer := map[string]any{"id": id, "type": "message", "role": "assistant", "model": model, "content": []any{map[string]any{"type": "text", "text": text}}, "stop_reason": "end_turn", "stop_sequence": nil}
		if hasUsage {
			answer["usage"] = map[string]any{"input_tokens": input, "output_tokens": output}
		}
		return answer
	default:
		answer := map[string]any{"id": id, "object": "response", "created_at": created, "status": "completed", "model": model, "output": []any{map[string]any{"id": "msg_" + id, "type": "message", "status": "completed", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}}}}
		if hasUsage {
			answer["usage"] = map[string]any{"input_tokens": input, "output_tokens": output, "total_tokens": input + output}
		}
		return answer
	}
}

func nonnegativeCount(raw any) (int64, bool) {
	switch n := raw.(type) {
	case int:
		return int64(n), n >= 0
	case int64:
		return n, n >= 0
	case float64:
		if n >= 0 && n < float64(math.MaxInt64) && math.Trunc(n) == n {
			return int64(n), true
		}
	}
	return 0, false
}
