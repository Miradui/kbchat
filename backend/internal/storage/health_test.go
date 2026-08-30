package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"kbchat/backend/internal/observability"
)

func TestLocalStorageCheckHealthAcceptsAnExistingDirectory(t *testing.T) {
	storage := NewLocalStorage(t.TempDir())

	if err := storage.CheckHealth(context.Background()); err != nil {
		t.Fatalf("expected a healthy upload directory: %v", err)
	}
}

func TestLocalStorageCheckHealthReportsAMissingDirectory(t *testing.T) {
	storage := NewLocalStorage(filepath.Join(t.TempDir(), "absent"))

	err := storage.CheckHealth(context.Background())
	if err == nil {
		t.Fatalf("expected a missing upload directory to be reported")
	}
	// The classifier is what turns this into an API-safe reason, so the error has
	// to stay recognizable to it.
	if reason := observability.Classify(err); reason != observability.ReasonNotFound {
		t.Fatalf("reason = %q, want %q", reason, observability.ReasonNotFound)
	}
}

func TestLocalStorageCheckHealthRejectsAFileAsRoot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	storage := NewLocalStorage(path)

	if err := storage.CheckHealth(context.Background()); !errors.Is(err, observability.ErrNotFound) {
		t.Fatalf("expected a file root to be reported as not found, got %v", err)
	}
}

type fakeHealthBackend struct {
	Storage
	err    error
	probed int
}

func (f *fakeHealthBackend) CheckHealth(context.Context) error {
	f.probed++
	return f.err
}

// A backend that does not implement the probe must report healthy, matching how
// EnsureReady treats the same case.
type plainBackend struct{ Storage }

func TestCheckHealthReturnsNilForBackendsWithoutTheCapability(t *testing.T) {
	if err := CheckHealth(context.Background(), &plainBackend{}); err != nil {
		t.Fatalf("expected an unsupported backend to report healthy: %v", err)
	}
}

// A healthy primary is not enough: documents already stored on the other backend
// become unreadable when it is down, so a failure anywhere must surface.
func TestRoutedStorageCheckHealthProbesBothBackends(t *testing.T) {
	local := &fakeHealthBackend{}
	remote := &fakeHealthBackend{err: errors.New("bucket unreachable")}
	routed := &RoutedStorage{primary: local, local: local, remote: remote}

	if err := routed.CheckHealth(context.Background()); err == nil {
		t.Fatalf("expected the failing remote backend to surface")
	}
	if local.probed != 1 || remote.probed != 1 {
		t.Fatalf("expected both backends probed once, got local=%d remote=%d", local.probed, remote.probed)
	}
}

func TestRoutedStorageCheckHealthProbesEachBackendOnce(t *testing.T) {
	only := &fakeHealthBackend{}
	routed := &RoutedStorage{primary: only, local: only, remote: only}

	if err := routed.CheckHealth(context.Background()); err != nil {
		t.Fatalf("expected healthy: %v", err)
	}
	if only.probed != 1 {
		t.Fatalf("expected a shared backend probed once, got %d", only.probed)
	}
}

// CheckHealth must not do what EnsureReady does. This is the guard for that
// split: a probe that creates or mutates storage would let an authenticated GET
// recreate a bucket an operator removed on purpose.
func TestCheckHealthDoesNotCallEnsureReady(t *testing.T) {
	backend := &mutatingBackend{}
	if err := CheckHealth(context.Background(), backend); err != nil {
		t.Fatalf("expected healthy: %v", err)
	}
	if backend.ensured {
		t.Fatalf("CheckHealth must not invoke EnsureReady")
	}
	if !backend.checked {
		t.Fatalf("CheckHealth must invoke CheckHealth")
	}
}

type mutatingBackend struct {
	Storage
	ensured bool
	checked bool
}

func (b *mutatingBackend) EnsureReady(context.Context) error {
	b.ensured = true
	return nil
}

func (b *mutatingBackend) CheckHealth(context.Context) error {
	b.checked = true
	return nil
}
