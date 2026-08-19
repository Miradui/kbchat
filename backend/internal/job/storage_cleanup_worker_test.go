package job

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"rag/backend/internal/model"
)

func TestStorageCleanupWorkerRetriesThenCompletes(t *testing.T) {
	leaseToken := uuid.New()
	cleanup := &model.StorageCleanupJob{ID: uuid.New(), StoragePath: "minio://bucket/object", LeaseToken: &leaseToken}
	store := &fakeStorageCleanupStore{pending: cleanup}
	deleter := &fakeStorageDeleter{err: errors.New("MinIO unavailable")}
	worker := NewStorageCleanupWorker(store, deleter, zap.NewNop(), Options{RetryDelay: time.Second})

	worker.runOnce(context.Background())
	if store.retryCount != 1 || store.completed {
		t.Fatalf("expected cleanup retry, got retry=%d completed=%t", store.retryCount, store.completed)
	}

	store.pending = cleanup
	cleanup.RetryCount = store.retryCount
	deleter.err = nil
	worker.runOnce(context.Background())
	if !store.completed {
		t.Fatal("expected cleanup job to complete after storage recovered")
	}
}

type fakeStorageCleanupStore struct {
	pending       *model.StorageCleanupJob
	retryCount    int
	completed     bool
	leaseDuration time.Duration
}

func (s *fakeStorageCleanupStore) ClaimPending(_ context.Context, leaseDuration time.Duration) (*model.StorageCleanupJob, error) {
	s.leaseDuration = leaseDuration
	pending := s.pending
	s.pending = nil
	return pending, nil
}

func (s *fakeStorageCleanupStore) Complete(_ context.Context, _, _ uuid.UUID) error {
	s.completed = true
	return nil
}

func (s *fakeStorageCleanupStore) Retry(_ context.Context, _, _ uuid.UUID, retryCount int, _ time.Time, _ string) error {
	s.retryCount = retryCount
	return nil
}

type fakeStorageDeleter struct {
	err          error
	deadlineSeen bool
}

func (d *fakeStorageDeleter) Delete(ctx context.Context, _ string) error {
	_, d.deadlineSeen = ctx.Deadline()
	return d.err
}

func TestStorageCleanupWorkerGivesDeleteAnOperationDeadline(t *testing.T) {
	leaseToken := uuid.New()
	cleanup := &model.StorageCleanupJob{ID: uuid.New(), StoragePath: "minio://bucket/object", LeaseToken: &leaseToken}
	store := &fakeStorageCleanupStore{pending: cleanup}
	deleter := &fakeStorageDeleter{}
	worker := NewStorageCleanupWorker(store, deleter, zap.NewNop(), Options{OperationTimeout: time.Second})

	worker.runOnce(context.Background())
	if !deleter.deadlineSeen {
		t.Fatal("expected storage cleanup delete to have an operation deadline")
	}
	if store.leaseDuration <= time.Second {
		t.Fatalf("expected lease %s to outlive operation timeout", store.leaseDuration)
	}
}
