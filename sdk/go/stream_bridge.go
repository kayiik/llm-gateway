package llmgwclient

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"strings"
	"time"
)

type textStreamBridge struct {
	source, target, model, id, messageID string
	created, sequence                    int64
	started, finished                    bool
	sourceStarted, sourceFinish          bool
	text                                 string
	inputTokens, outputTokens            int64
	inputKnown, outputKnown              bool
}

func streamID(prefix string) string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return prefix + hex.EncodeToString(raw[:])
	}
	return fmt.Sprintf("%s%d", prefix, time.Now().UnixNano())
}

func newTextStreamBridge(source, target, model string) *textStreamBridge {
	return &textStreamBridge{source: source, target: target, model: model, id: streamID("local_"), messageID: streamID("msg_"), created: time.Now().Unix()}
}

func objectOf(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func stringOf(value any) string {
	result, _ := value.(string)
	return result
}

func indexZero(value any) bool {
	n, valid := nonnegativeCount(value)
	return valid && n == 0
}

func emptyOrMissing(value any) bool {
	if value == nil {
		return true
	}
	list, ok := value.([]any)
	return ok && len(list) == 0
}

func textStreamPart(value any) bool {
	part := objectOf(value)
	if part == nil || part["type"] != "output_text" || !emptyOrMissing(part["annotations"]) {
		return false
	}
	_, ok := part["text"].(string)
	return ok
}

func (b *textStreamBridge) identity(value map[string]any) {
	if b.started || value == nil {
		return
	}
	if id := stringOf(value["id"]); id != "" {
		b.id = id
	}
	if created, ok := nonnegativeCount(value["created"]); ok {
		b.created = created
	} else if created, ok := nonnegativeCount(value["created_at"]); ok {
		b.created = created
	}
	if model := stringOf(value["model"]); model != "" {
		b.model = model
	}
}

func (b *textStreamBridge) mergeUsage(value any) {
	usage := objectOf(value)
	if usage == nil {
		return
	}
	if count, ok := nonnegativeCount(usage["input_tokens"]); ok {
		b.inputTokens, b.inputKnown = count, true
	} else if count, ok := nonnegativeCount(usage["prompt_tokens"]); ok {
		b.inputTokens, b.inputKnown = count, true
	}
	if count, ok := nonnegativeCount(usage["output_tokens"]); ok {
		b.outputTokens, b.outputKnown = count, true
	} else if count, ok := nonnegativeCount(usage["completion_tokens"]); ok {
		b.outputTokens, b.outputKnown = count, true
	}
}

func (b *textStreamBridge) event(kind string, value any) StreamEvent {
	if b.target != "responses" {
		return StreamEvent{Event: kind, Data: value}
	}
	data := objectOf(value)
	data["type"] = kind
	data["sequence_number"] = b.sequence
	b.sequence++
	return StreamEvent{Event: kind, Data: data}
}

func (b *textStreamBridge) envelope(status string) map[string]any {
	var usage any
	if b.inputKnown && b.outputKnown && b.inputTokens <= math.MaxInt64-b.outputTokens {
		usage = map[string]any{"input_tokens": b.inputTokens, "output_tokens": b.outputTokens, "total_tokens": b.inputTokens + b.outputTokens}
	}
	output := []any{}
	if status == "completed" {
		output = append(output, map[string]any{"id": b.messageID, "type": "message", "status": "completed", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": b.text, "annotations": []any{}}}})
	}
	return map[string]any{"id": b.id, "object": "response", "created_at": b.created, "status": status, "model": b.model,
		"output": output, "store": false, "background": false, "previous_response_id": nil, "usage": usage}
}

func (b *textStreamBridge) start() []StreamEvent {
	if b.started {
		return nil
	}
	b.started = true
	switch b.target {
	case "chat":
		return []StreamEvent{b.event("message", map[string]any{"id": b.id, "object": "chat.completion.chunk", "created": b.created,
			"model": b.model, "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant"}, "finish_reason": nil}}})}
	case "messages":
		input := int64(0)
		if b.inputKnown {
			input = b.inputTokens
		}
		return []StreamEvent{
			b.event("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": b.id, "type": "message", "role": "assistant", "model": b.model,
				"content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": map[string]any{"input_tokens": input, "output_tokens": 0}}}),
			b.event("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}}),
		}
	default:
		return []StreamEvent{
			b.event("response.created", map[string]any{"response": b.envelope("in_progress")}),
			b.event("response.output_item.added", map[string]any{"response_id": b.id, "output_index": 0,
				"item": map[string]any{"id": b.messageID, "type": "message", "status": "in_progress", "role": "assistant", "content": []any{}}}),
			b.event("response.content_part.added", map[string]any{"response_id": b.id, "item_id": b.messageID, "output_index": 0, "content_index": 0,
				"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}}),
		}
	}
}

func (b *textStreamBridge) delta(value any) ([]StreamEvent, error) {
	text, ok := value.(string)
	if !ok {
		return nil, &StreamProtocolError{"text delta is not a string"}
	}
	out := b.start()
	if text == "" {
		return out, nil
	}
	b.text += text
	switch b.target {
	case "chat":
		out = append(out, b.event("message", map[string]any{"id": b.id, "object": "chat.completion.chunk", "created": b.created, "model": b.model,
			"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": text}, "finish_reason": nil}}}))
	case "messages":
		out = append(out, b.event("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}}))
	default:
		out = append(out, b.event("response.output_text.delta", map[string]any{"response_id": b.id, "item_id": b.messageID,
			"output_index": 0, "content_index": 0, "delta": text}))
	}
	return out, nil
}

func (b *textStreamBridge) terminal() ([]StreamEvent, error) {
	if !b.sourceFinish || b.finished {
		return nil, &StreamProtocolError{"upstream stream lacks a valid text terminal"}
	}
	b.finished = true
	out := b.start()
	switch b.target {
	case "chat":
		return append(out,
			b.event("message", map[string]any{"id": b.id, "object": "chat.completion.chunk", "created": b.created, "model": b.model,
				"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}}}),
			b.event("message", "[DONE]")), nil
	case "messages":
		output := int64(0)
		if b.outputKnown {
			output = b.outputTokens
		}
		return append(out,
			b.event("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0}),
			b.event("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn", "stop_sequence": nil},
				"usage": map[string]any{"output_tokens": output}}),
			b.event("message_stop", map[string]any{"type": "message_stop"})), nil
	default:
		part := map[string]any{"type": "output_text", "text": b.text, "annotations": []any{}}
		item := map[string]any{"id": b.messageID, "type": "message", "status": "completed", "role": "assistant", "content": []any{part}}
		return append(out,
			b.event("response.output_text.done", map[string]any{"response_id": b.id, "item_id": b.messageID, "output_index": 0, "content_index": 0, "text": b.text}),
			b.event("response.content_part.done", map[string]any{"response_id": b.id, "item_id": b.messageID, "output_index": 0, "content_index": 0, "part": part}),
			b.event("response.output_item.done", map[string]any{"response_id": b.id, "output_index": 0, "item": item}),
			b.event("response.completed", map[string]any{"response": b.envelope("completed")})), nil
	}
}

func (b *textStreamBridge) feed(record StreamEvent) ([]StreamEvent, error) {
	if b.finished {
		return nil, &StreamProtocolError{"upstream sent events after the terminal"}
	}
	data, _ := record.Data.(map[string]any)
	if record.Event == "error" || data["error"] != nil || data["type"] == "error" || data["type"] == "response.failed" {
		return nil, &StreamProtocolError{"upstream stream reported an error"}
	}
	if b.source == "chat" {
		if record.Data == "[DONE]" {
			if !b.sourceFinish {
				return nil, &StreamProtocolError{"Chat stream lacks finish reason"}
			}
			return b.terminal()
		}
		choices, ok := data["choices"].([]any)
		if !ok || len(choices) > 1 {
			return nil, &StreamProtocolError{"Chat stream has unrepresentable choices"}
		}
		b.identity(data)
		b.mergeUsage(data["usage"])
		if len(choices) == 0 {
			return nil, nil
		}
		choice := objectOf(choices[0])
		delta := objectOf(choice["delta"])
		if choice == nil || choice["index"] != nil && !indexZero(choice["index"]) || delta == nil ||
			stringOf(delta["role"]) != "" && stringOf(delta["role"]) != "assistant" ||
			choice["finish_reason"] != nil && choice["finish_reason"] != "stop" {
			return nil, &StreamProtocolError{"Chat stream has unsupported semantic content"}
		}
		for key := range choice {
			if key != "index" && key != "delta" && key != "finish_reason" {
				return nil, &StreamProtocolError{"Chat stream has unsupported semantic content"}
			}
		}
		for key := range delta {
			if key != "role" && key != "content" {
				return nil, &StreamProtocolError{"Chat stream has unsupported semantic content"}
			}
		}
		if b.sourceFinish {
			return nil, &StreamProtocolError{"Chat stream sent content after its finish reason"}
		}
		value := delta["content"]
		if value == nil {
			value = ""
		}
		out, err := b.delta(value)
		if choice["finish_reason"] == "stop" {
			b.sourceFinish = true
		}
		return out, err
	}
	if data == nil {
		return nil, &StreamProtocolError{"upstream stream event is not an object"}
	}
	kind := stringOf(data["type"])
	if kind == "" {
		kind = record.Event
	}
	if b.source == "messages" {
		if kind == "ping" {
			return nil, nil
		}
		if kind == "message_start" {
			message := objectOf(data["message"])
			if b.sourceStarted || message == nil || message["role"] != nil && message["role"] != "assistant" || !emptyOrMissing(message["content"]) {
				return nil, &StreamProtocolError{"invalid Messages start event"}
			}
			b.sourceStarted = true
			b.identity(message)
			b.mergeUsage(message["usage"])
			return b.start(), nil
		}
		if !b.sourceStarted {
			return nil, &StreamProtocolError{"Messages stream lacks message_start"}
		}
		if b.sourceFinish && kind != "message_stop" {
			return nil, &StreamProtocolError{"Messages stream sent content after its stop reason"}
		}
		switch kind {
		case "content_block_start":
			block := objectOf(data["content_block"])
			if !indexZero(data["index"]) || block == nil || block["type"] != "text" {
				return nil, &StreamProtocolError{"non-text Messages block"}
			}
			for key := range block {
				if key != "type" && key != "text" {
					return nil, &StreamProtocolError{"non-text Messages block"}
				}
			}
			value := block["text"]
			if value == nil {
				value = ""
			}
			return b.delta(value)
		case "content_block_delta":
			delta := objectOf(data["delta"])
			if !indexZero(data["index"]) || delta == nil || delta["type"] != "text_delta" {
				return nil, &StreamProtocolError{"non-text Messages delta"}
			}
			for key := range delta {
				if key != "type" && key != "text" {
					return nil, &StreamProtocolError{"non-text Messages delta"}
				}
			}
			return b.delta(delta["text"])
		case "content_block_stop":
			if !indexZero(data["index"]) {
				return nil, &StreamProtocolError{"unknown Messages block"}
			}
			return nil, nil
		case "message_delta":
			delta := objectOf(data["delta"])
			if delta == nil || delta["stop_reason"] != "end_turn" || delta["stop_sequence"] != nil {
				return nil, &StreamProtocolError{"Messages stream did not finish a text turn"}
			}
			b.mergeUsage(data["usage"])
			b.sourceFinish = true
			return nil, nil
		case "message_stop":
			return b.terminal()
		default:
			return nil, &StreamProtocolError{"unsupported Messages event"}
		}
	}
	if kind == "response.created" || kind == "response.in_progress" {
		response := objectOf(data["response"])
		if response == nil || !emptyOrMissing(response["output"]) {
			return nil, &StreamProtocolError{"Responses stream lacks response envelope"}
		}
		b.sourceStarted = true
		b.identity(response)
		b.mergeUsage(response["usage"])
		return b.start(), nil
	}
	if !b.sourceStarted {
		return nil, &StreamProtocolError{"Responses stream lacks response.created"}
	}
	switch kind {
	case "response.output_item.added", "response.output_item.done":
		item := objectOf(data["item"])
		if !indexZero(data["output_index"]) || item == nil || item["type"] != "message" || item["role"] != "assistant" {
			return nil, &StreamProtocolError{"non-text Responses output item"}
		}
		var text strings.Builder
		parts, ok := item["content"].([]any)
		if !ok && item["content"] != nil {
			return nil, &StreamProtocolError{"Responses output item has unsupported content"}
		}
		for _, raw := range parts {
			if !textStreamPart(raw) {
				return nil, &StreamProtocolError{"Responses output item has unsupported content"}
			}
			text.WriteString(stringOf(objectOf(raw)["text"]))
		}
		if kind == "response.output_item.added" && len(parts) > 0 || kind == "response.output_item.done" && len(parts) > 0 && text.String() != b.text {
			return nil, &StreamProtocolError{"Responses output item changed streamed text"}
		}
		return nil, nil
	case "response.content_part.added", "response.content_part.done":
		part := objectOf(data["part"])
		if !indexZero(data["output_index"]) || !indexZero(data["content_index"]) || !textStreamPart(part) {
			return nil, &StreamProtocolError{"non-text Responses content part"}
		}
		value, ok := part["text"].(string)
		if !ok || strings.HasSuffix(kind, ".done") && value != b.text {
			return nil, &StreamProtocolError{"Responses content changed after delivery"}
		}
		if strings.HasSuffix(kind, ".done") {
			return nil, nil
		}
		return b.delta(value)
	case "response.output_text.delta":
		if !indexZero(data["output_index"]) || !indexZero(data["content_index"]) || !emptyOrMissing(data["logprobs"]) {
			return nil, &StreamProtocolError{"unexpected Responses text index"}
		}
		return b.delta(data["delta"])
	case "response.output_text.done":
		if b.text == "" {
			if value, ok := data["text"].(string); ok {
				return b.delta(value)
			}
		}
		if data["text"] != b.text {
			return nil, &StreamProtocolError{"Responses text changed after delivery"}
		}
		return nil, nil
	case "response.completed":
		response := objectOf(data["response"])
		if response == nil || response["status"] != "completed" {
			return nil, &StreamProtocolError{"Responses stream did not complete"}
		}
		items, ok := response["output"].([]any)
		if !ok {
			return nil, &StreamProtocolError{"Responses terminal has non-text output"}
		}
		var final strings.Builder
		for _, raw := range items {
			item := objectOf(raw)
			if item == nil || item["type"] != "message" || item["role"] != "assistant" {
				return nil, &StreamProtocolError{"Responses terminal has non-text output"}
			}
			parts, ok := item["content"].([]any)
			if !ok {
				return nil, &StreamProtocolError{"Responses terminal has non-text output"}
			}
			for _, rawPart := range parts {
				part := objectOf(rawPart)
				if !textStreamPart(part) {
					return nil, &StreamProtocolError{"Responses terminal has non-text output"}
				}
				value, ok := part["text"].(string)
				if !ok {
					return nil, &StreamProtocolError{"Responses terminal has non-text output"}
				}
				final.WriteString(value)
			}
		}
		if b.text != "" && final.String() != b.text {
			return nil, &StreamProtocolError{"Responses terminal changed delivered text"}
		}
		b.mergeUsage(response["usage"])
		var out []StreamEvent
		if b.text == "" {
			var err error
			out, err = b.delta(final.String())
			if err != nil {
				return nil, err
			}
		}
		b.sourceFinish = true
		terminal, err := b.terminal()
		return append(out, terminal...), err
	default:
		return nil, &StreamProtocolError{"unsupported Responses event"}
	}
}
