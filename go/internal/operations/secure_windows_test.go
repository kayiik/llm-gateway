//go:build windows

package operations

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// holdOpen opens path shared for reading only, as a scanner may for a
// moment after a file is written, so that it cannot be renamed while open.
func holdOpen(t *testing.T, path string) windows.Handle {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil,
		windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	return handle
}

// A restore renames current state aside, and a file another process holds
// open for a moment delays the rename instead of failing it.
func TestDurableRenameWaitsForAFileHeldOpenBriefly(t *testing.T) {
	dir := t.TempDir()
	source, destination := filepath.Join(dir, "gateway.db"), filepath.Join(dir, "gateway.db.rollback")
	if err := os.WriteFile(source, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	handle := holdOpen(t, source)
	released := make(chan struct{})
	go func() {
		defer close(released)
		time.Sleep(200 * time.Millisecond)
		_ = windows.CloseHandle(handle)
	}()
	t.Cleanup(func() { <-released })
	if err := durableRename(source, destination); err != nil {
		t.Fatalf("rename of a file held open briefly: %v", err)
	}
	if data, err := os.ReadFile(destination); err != nil || string(data) != "state" {
		t.Fatalf("renamed file = %q, %v", data, err)
	}
}

// A file held open for good still fails the rename, once the retries end.
func TestDurableRenameGivesUpOnAFileHeldOpen(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "gateway.db")
	if err := os.WriteFile(source, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	handle := holdOpen(t, source)
	t.Cleanup(func() { _ = windows.CloseHandle(handle) })
	started := time.Now()
	err := durableRename(source, filepath.Join(dir, "gateway.db.rollback"))
	if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		t.Fatalf("err = %v, want a sharing violation", err)
	}
	if elapsed := time.Since(started); elapsed < moveRetryWindow || elapsed > moveRetryWindow+time.Second {
		t.Fatalf("gave up after %v, want about %v", elapsed, moveRetryWindow)
	}
}

func TestSecureTemporaryDirectoryUsesProtectedACL(t *testing.T) {
	dir, err := makeSecureTempDir("llmgw-acl-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	descriptor, err := windows.GetNamedSecurityInfo(
		dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := descriptor.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("temporary directory DACL is not protected: %#x", control)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if dacl == nil || dacl.AceCount != 2 {
		t.Fatalf("temporary directory ACE count=%v, want system and current user", dacl)
	}
}
