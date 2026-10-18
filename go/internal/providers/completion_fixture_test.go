package providers

import (
	"encoding/json"
	"strings"
	"testing"
)

// Completion IDs are opaque operation values, not fixture constants. Check
// identity on every frame before normalizing only that field for exact diffs.
func completionFixtureChunks(t *testing.T, chunks []string, placeholder string) []string {
	t.Helper()
	result := make([]string, 0, len(chunks))
	var operationID string
	for _, chunk := range chunks {
		var value map[string]any
		decoder := json.NewDecoder(strings.NewReader(chunk))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			t.Fatal(err)
		}
		id, _ := value["id"].(string)
		if id == "" || (operationID != "" && id != operationID) {
			t.Fatalf("completion ID changed from %q to %q", operationID, id)
		}
		operationID = id
		value["id"] = placeholder
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		result = append(result, string(encoded))
	}
	return result
}
