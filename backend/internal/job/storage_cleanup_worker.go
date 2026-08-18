package job

import (
	"context"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"rag/backend/internal/model"
)

const maxStorageCleanupBackoff = 30 * time.Minute

type StorageCleanupStore interface {
	ClaimPending(context.Context) (*model.StorageCleanupJob, error)
	Complete(context.Context, uuid.UUID, uuid.UUID) error
	Retry(context.Context, uuid.UUID, uuid.UUID, int, time.Time, string) error
}

type StorageDeleter interface {
	Delete(context.Context, string) error
}

type StorageCleanupWorker struct {
	jobs       StorageCleanupStore
	storage    StorageDeleter
	logger     *zap.Logger
	interval   time.Duration
	retryDelay time.Duration
}

func NewStorageCleanupWorker(jobs StorageCleanupStore, storage StorageDeleter, logger *zap.Logger, options Options) *StorageCleanupWorker {
	if options.Interval <= 0 {
		options.Interval = defaultInterval
	}
	if options.RetryDelay <= 0 {
		options.RetryDelay = defaultRetryDelay
	}
	return &StorageCleanupWorker{
		jobs:       jobs,
		storage:    storage,
		logger:     logger,
		interval:   options.Interval,
		retryDelay: options.RetryDelay,
	}
}

func (w *StorageCleanupWorker) Start(ctx context.Context) {
	w.logger.Info("storage cleanup worker started")
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		w.runOnce(ctx)
		select {
		case <-ctx.Done():
			w.logger.Info("storage cleanup worker stopped")
			return
		case <-ticker.C:
		}
	}
}

func (w *StorageCleanupWorker) runOnce(ctx context.Context) {
	for ctx.Err() == nil {
		cleanup, err := w.jobs.ClaimPending(ctx)
		if err != nil {
			if ctx.Err() == nil {
				w.logger.Error("claim storage cleanup job failed", zap.Error(err))
			}
			return
		}
		if cleanup == nil {
			return
		}
		w.process(ctx, cleanup)
	}
}

func (w *StorageCleanupWorker) process(ctx context.Context, cleanup *model.StorageCleanupJob) {
	if cleanup.LeaseToken == nil {
		w.logger.Error("storage cleanup job has no lease token", zap.String("cleanup_job_id", cleanup.ID.String()))
		return
	}
	if err := w.storage.Delete(ctx, cleanup.StoragePath); err != nil {
		retryCount := cleanup.RetryCount + 1
		retryAt := time.Now().Add(storageCleanupBackoff(w.retryDelay, retryCount))
		w.logger.Warn("storage cleanup scheduled for retry",
			zap.String("cleanup_job_id", cleanup.ID.String()),
			zap.Int("retry_count", retryCount),
			zap.Time("retry_at", retryAt),
			zap.Error(err),
		)
		if retryErr := w.jobs.Retry(ctx, cleanup.ID, *cleanup.LeaseToken, retryCount, retryAt, err.Error()); retryErr != nil && ctx.Err() == nil {
			w.logger.Error("schedule storage cleanup retry failed", zap.Error(retryErr))
		}
		return
	}
	if err := w.jobs.Complete(ctx, cleanup.ID, *cleanup.LeaseToken); err != nil && ctx.Err() == nil {
		w.logger.Error("complete storage cleanup job failed", zap.Error(err))
	}
}

func storageCleanupBackoff(base time.Duration, retryCount int) time.Duration {
	delay := base
	for i := 1; i < retryCount && delay < maxStorageCleanupBackoff; i++ {
		delay *= 2
		if delay > maxStorageCleanupBackoff {
			return maxStorageCleanupBackoff
		}
	}
	return delay
}
