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
	pending    *model.StorageCleanupJob
	retryCount int
	completed  bool
}

func (s *fakeStorageCleanupStore) ClaimPending(context.Context) (*model.StorageCleanupJob, error) {
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
	err error
}

func (d *fakeStorageDeleter) Delete(context.Context, string) error {
	return d.err
}
