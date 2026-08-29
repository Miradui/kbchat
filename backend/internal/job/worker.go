package job

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

const (
	defaultInterval    = 3 * time.Second
	defaultConcurrency = 1
	defaultMaxRetries  = 3
	defaultRetryDelay  = 10 * time.Second
)

type DocumentStore interface {
	RecoverRunningJobs(ctx context.Context) error
	ClaimPendingJob(ctx context.Context) (*model.DocumentJob, error)
	CompleteJob(ctx context.Context, jobID uuid.UUID) error
	FailJob(ctx context.Context, jobID uuid.UUID, message string) error
	RetryJob(ctx context.Context, jobID uuid.UUID, retryCount int, retryAt time.Time, message string) error
}

type DocumentProcessor interface {
	Process(ctx context.Context, job *model.DocumentJob) error
}

type Options struct {
	Interval         time.Duration
	Concurrency      int
	MaxRetries       int
	RetryDelay       time.Duration
	OperationTimeout time.Duration
}

type Worker struct {
	documents   DocumentStore
	processor   DocumentProcessor
	logger      *zap.Logger
	interval    time.Duration
	concurrency int
	maxRetries  int
	retryDelay  time.Duration
}

func NewWorker(
	documents DocumentStore,
	processor DocumentProcessor,
	logger *zap.Logger,
) *Worker {
	return NewWorkerWithOptions(documents, processor, logger, Options{})
}

func NewWorkerWithOptions(
	documents DocumentStore,
	processor DocumentProcessor,
	logger *zap.Logger,
	options Options,
) *Worker {
	if options.Interval <= 0 {
		options.Interval = defaultInterval
	}
	if options.Concurrency <= 0 {
		options.Concurrency = defaultConcurrency
	}
	if options.MaxRetries <= 0 {
		options.MaxRetries = defaultMaxRetries
	}
	if options.RetryDelay <= 0 {
		options.RetryDelay = defaultRetryDelay
	}
	return &Worker{
		documents:   documents,
		processor:   processor,
		logger:      logger,
		interval:    options.Interval,
		concurrency: options.Concurrency,
		maxRetries:  options.MaxRetries,
		retryDelay:  options.RetryDelay,
	}
}

func (w *Worker) Start(ctx context.Context) {
	w.logger.Info("document worker started")
	if err := w.documents.RecoverRunningJobs(ctx); err != nil {
		w.logger.Error("recover interrupted document jobs failed", zap.Error(err))
		return
	}

	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("document worker stopped")
			return
		default:
			w.runOnce(ctx)
		}

		select {
		case <-ctx.Done():
			w.logger.Info("document worker stopped")
			return
		case <-ticker.C:
		}
	}
}

func (w *Worker) runOnce(ctx context.Context) {
	var wg sync.WaitGroup
	for i := 0; i < w.concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.runClaimLoop(ctx)
		}()
	}
	wg.Wait()
}

func (w *Worker) runClaimLoop(ctx context.Context) {
	for {
		if err := ctx.Err(); err != nil {
			return
		}

		job, err := w.documents.ClaimPendingJob(ctx)
		if err != nil {
			if ctx.Err() == nil {
				w.logger.Error("claim document job failed", zap.Error(err))
			}
			return
		}
		if job == nil {
			return
		}

		w.process(ctx, job)
	}
}

func (w *Worker) process(ctx context.Context, job *model.DocumentJob) {
	w.logger.Info("processing document job",
		zap.String("job_id", job.ID.String()),
		zap.String("document_id", job.DocumentID.String()),
	)

	if err := w.processor.Process(ctx, job); err != nil {
		// A cancel already wrote the terminal state for both the job and the
		// document. RetryJob and FailJob are guarded on status='running' and
		// would no-op anyway; returning here keeps the log honest.
		if errors.Is(err, repository.ErrDocumentJobCancelled) {
			w.logger.Info("document job cancelled",
				zap.String("job_id", job.ID.String()),
				zap.String("document_id", job.DocumentID.String()),
			)
			return
		}

		message := err.Error()
		if job.RetryCount < w.maxRetries {
			nextRetryCount := job.RetryCount + 1
			retryAt := time.Now().Add(w.retryDelay)
			w.logger.Warn("document job scheduled for retry",
				zap.String("job_id", job.ID.String()),
				zap.String("document_id", job.DocumentID.String()),
				zap.Int("retry_count", nextRetryCount),
				zap.Int("max_retries", w.maxRetries),
				zap.Time("retry_at", retryAt),
				zap.Error(err),
			)
			if retryErr := w.documents.RetryJob(ctx, job.ID, nextRetryCount, retryAt, message); retryErr != nil {
				w.logger.Error("schedule document job retry failed",
					zap.String("job_id", job.ID.String()),
					zap.Error(retryErr),
				)
			}
			return
		}

		w.logger.Error("document job failed",
			zap.String("job_id", job.ID.String()),
			zap.String("document_id", job.DocumentID.String()),
			zap.Int("retry_count", job.RetryCount),
			zap.Int("max_retries", w.maxRetries),
			zap.Error(err),
		)
		if failErr := w.documents.FailJob(ctx, job.ID, message); failErr != nil {
			w.logger.Error("finalize failed document job failed",
				zap.String("job_id", job.ID.String()),
				zap.String("document_id", job.DocumentID.String()),
				zap.Error(failErr),
			)
		}
		return
	}

	if err := w.documents.CompleteJob(ctx, job.ID); err != nil {
		w.logger.Error("complete document job failed",
			zap.String("job_id", job.ID.String()),
			zap.Error(err),
		)
		return
	}

	w.logger.Info("document job completed",
		zap.String("job_id", job.ID.String()),
		zap.String("document_id", job.DocumentID.String()),
	)
}
