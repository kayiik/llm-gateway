package iam

import "encoding/json"

// UsageEvidence records accounting provenance independently of legacy aggregate
// counters. It contains only recognized counts, never arbitrary provider bodies.
type UsageEvidence struct {
	Version              int           `json:"version"`
	InputBasis           string        `json:"input_basis"`
	OutputBasis          string        `json:"output_basis"`
	InputIncomplete      bool          `json:"input_incomplete,omitempty"`
	OutputIncomplete     bool          `json:"output_incomplete,omitempty"`
	Invalid              bool          `json:"invalid,omitempty"`
	HistoryTruncated     bool          `json:"history_truncated,omitempty"`
	SelectedAttempt      int           `json:"selected_attempt"`
	SelectionUnavailable bool          `json:"selection_unavailable,omitempty"`
	Attempts             []UsageSource `json:"attempts"`
}

type UsageSource struct {
	API          string                      `json:"api"`
	Dialect      string                      `json:"dialect"`
	Provider     string                      `json:"provider,omitempty"`
	Model        string                      `json:"model,omitempty"`
	Attempt      uint64                      `json:"attempt"`
	Quality      string                      `json:"quality"`
	Cancelled    bool                        `json:"cancelled,omitempty"`
	Invalid      bool                        `json:"invalid,omitempty"`
	Truncated    bool                        `json:"truncated,omitempty"`
	Raw          map[string]json.RawMessage  `json:"raw,omitempty"`
	RawTruncated bool                        `json:"raw_truncated,omitempty"`
	Counts       map[string]UsageSourceCount `json:"counts"`
}

type UsageSourceCount struct {
	Value      int64  `json:"value"`
	Presence   string `json:"presence"`
	Provenance string `json:"provenance"`
	Path       string `json:"path,omitempty"`
}
