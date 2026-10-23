package operations

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestMain(m *testing.M) {
	// Backup also includes a cache rooted in the home directory, independently
	// of LLMGW_STATE_DIR. Every fallback must stay inside disposable test state.
	home, err := os.MkdirTemp("", "llmgw-operations-home-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "create operations test home:", err)
		os.Exit(1)
	}
	for name, value := range map[string]string{
		"HOME": home, "USERPROFILE": home,
		"LLMGW_STATE_DIR":                filepath.Join(home, "state"),
		"LLMGW_CONFIG":                   filepath.Join(home, "config.yaml"),
		"LLMGW_GITHUB_COPILOT_CACHE_DIR": filepath.Join(home, "cache"),
	} {
		if err := os.Setenv(name, value); err != nil {
			fmt.Fprintln(os.Stderr, "isolate operations test environment:", err)
			_ = os.RemoveAll(home)
			os.Exit(1)
		}
	}
	code := m.Run()
	_ = os.RemoveAll(home)
	os.Exit(code)
}
