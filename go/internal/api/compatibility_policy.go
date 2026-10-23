package api

import (
	"errors"
	"net/http"
	"strings"
)

const compatibilityHeader = "X-LLMGW-Compatibility"

var errCompatibilityHeader = errors.New("X-LLMGW-Compatibility must be allow or deny, without repeated values")

// singlePolicyHeader rejects ambiguous proxy/header combinations instead of
// allowing Header.Get to hide a second, potentially contradictory value.
func singlePolicyHeader(header http.Header, name string) (string, bool, bool) {
	var values []string
	present := false
	for key, entries := range header {
		if strings.EqualFold(key, name) {
			present = true
			values = append(values, entries...)
		}
	}
	if !present {
		return "", false, true
	}
	if len(values) != 1 {
		return "", true, false
	}
	return strings.TrimSpace(values[0]), true, true
}

func requestedCompatibility(r *http.Request) (string, error) {
	value, present, valid := singlePolicyHeader(r.Header, compatibilityHeader)
	if !valid {
		return "", errCompatibilityHeader
	}
	if !present {
		return "", nil
	}
	switch strings.ToLower(value) {
	case "allow":
		return "allow", nil
	case "deny":
		return "deny", nil
	}
	return "", errCompatibilityHeader
}
