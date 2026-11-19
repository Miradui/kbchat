package job

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"go.opentelemetry.io/otel/attribute"
	"kbchat/backend/internal/document/processor"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/observability"
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
	FailJobWithCode(ctx context.Context, jobID uuid.UUID, message, errorCode string) error
	RetryJob(ctx context.Context, jobID uuid.UUID, retryCount int, retryAt time.Time, message string) error
}

type DocumentProcessor interface {
	Process(ctx context.Context, job *model.DocumentJob) error
}

type Options struct {
	Recorder         *observability.Recorder
	Interval         time.Duration
	Concurrency      int
	MaxRetries       int
	RetryDelay       time.Duration
	OperationTimeout time.Duration
}

type Worker struct {
	metrics     *observability.Recorder
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
		metrics:     options.Recorder,
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
	w.recoverRunningJobs(ctx)

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

// recoverRunningJobs retries until recovery succeeds or the worker stops.
//
// Giving up on the first failure left a half-dead worker: HTTP kept answering and
// uploads kept returning 201, but no goroutine ever claimed a job, so every
// document stayed pending with one ERROR line to explain it and nothing in the
// diagnostics to show it. A database blip during startup is exactly what a retry
// recovers from, and until recovery succeeds there is nothing safe to claim.
func (w *Worker) recoverRunningJobs(ctx context.Context) {
	for attempt := 1; ; attempt++ {
		err := w.documents.RecoverRunningJobs(ctx)
		if err == nil {
			if attempt > 1 {
				w.logger.Info("recovered interrupted document jobs", zap.Int("attempts", attempt))
			}
			return
		}
		w.logger.Error("recover interrupted document jobs failed; retrying",
			zap.Int("attempt", attempt),
			zap.Duration("retry_delay", w.retryDelay),
			zap.Error(err),
		)
		select {
		case <-ctx.Done():
			return
		case <-time.After(w.retryDelay):
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

		w.processSafely(ctx, job)
	}
}

// processSafely keeps one document from taking the process down. Parsing,
// splitting and OCR all run on untrusted uploads; a panic there is a bug, but
// it must fail the job instead of killing every in-flight request and leaving
// the job stuck in 'running'. The job is finalized as 'internal' rather than
// retried: a panic is not a transient condition.
func (w *Worker) processSafely(ctx context.Context, job *model.DocumentJob) {
	ctx = observability.WithTraceParent(ctx, job.Traceparent)
	ctx, span := observability.Start(ctx, "document.process", attribute.String("job.id", job.ID.String()), attribute.String("document.id", job.DocumentID.String()), attribute.Int("job.attempt", job.RetryCount+1))
	started := time.Now()
	var jobErr error
	defer func() {
		if errors.Is(jobErr, repository.ErrDocumentJobCancelled) {
			jobErr = context.Canceled
		}
		outcome := "completed"
		if jobErr != nil {
			outcome = "failed"
		}
		if errors.Is(jobErr, context.Canceled) {
			outcome = "cancelled"
		}
		w.metrics.RecordJobAttempt(ctx, outcome, time.Since(started))
		observability.Finish(span, jobErr)
	}()
	log := observability.Log(ctx, w.logger)
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		message := fmt.Sprintf("panic while processing document: %v", recovered)
		jobErr = fmt.Errorf("document processor panicked")
		log.Error("document job panicked",
			zap.String("job_id", job.ID.String()),
			zap.String("document_id", job.DocumentID.String()),
			zap.Any("panic", recovered),
			zap.ByteString("stack", debug.Stack()),
		)
		// The worker context may already be cancelled; the terminal write still
		// has to happen so the job does not stay 'running' until next startup.
		failCtx := context.WithoutCancel(ctx)
		if err := w.documents.FailJobWithCode(failCtx, job.ID, message, processor.ErrorCodeInternal); err != nil {
			log.Error("finalize panicked document job failed",
				zap.String("job_id", job.ID.String()),
				zap.String("document_id", job.DocumentID.String()),
				zap.Error(err),
			)
		}
	}()
	jobErr = w.process(ctx, job)
}

func (w *Worker) process(ctx context.Context, job *model.DocumentJob) error {
	log := observability.Log(ctx, w.logger)
	log.Info("processing document job",
		zap.String("job_id", job.ID.String()),
		zap.String("document_id", job.DocumentID.String()),
	)

	if err := w.processor.Process(ctx, job); err != nil {
		// A cancel already wrote the terminal state for both the job and the
		// document. RetryJob and FailJob are guarded on status='running' and
		// would no-op anyway; returning here keeps the log honest.
		if errors.Is(err, repository.ErrDocumentJobCancelled) {
			log.Info("document job cancelled",
				zap.String("job_id", job.ID.String()),
				zap.String("document_id", job.DocumentID.String()),
			)
			return err
		}

		message := err.Error()
		permanent := processor.IsPermanent(err)
		if job.RetryCount < w.maxRetries && !permanent {
			nextRetryCount := job.RetryCount + 1
			retryAt := time.Now().Add(w.retryDelay)
			log.Warn("document job scheduled for retry",
				zap.String("job_id", job.ID.String()),
				zap.String("document_id", job.DocumentID.String()),
				zap.Int("retry_count", nextRetryCount),
				zap.Int("max_retries", w.maxRetries),
				zap.Time("retry_at", retryAt),
				zap.Error(err),
			)
			if retryErr := w.documents.RetryJob(ctx, job.ID, nextRetryCount, retryAt, message); retryErr != nil {
				log.Error("schedule document job retry failed",
					zap.String("job_id", job.ID.String()),
					zap.Error(retryErr),
				)
			}
			return err
		}

		log.Error("document job failed",
			zap.String("job_id", job.ID.String()),
			zap.String("document_id", job.DocumentID.String()),
			zap.Int("retry_count", job.RetryCount),
			zap.Int("max_retries", w.maxRetries),
			zap.Bool("permanent", permanent),
			zap.Error(err),
		)
		// Classified only on the terminal failure: a retry is still in progress, so
		// stamping a code on it would show the user a reason for something the
		// server is about to try again.
		errorCode := processor.ClassifyError(err)
		if failErr := w.documents.FailJobWithCode(ctx, job.ID, message, errorCode); failErr != nil {
			log.Error("finalize failed document job failed",
				zap.String("job_id", job.ID.String()),
				zap.String("document_id", job.DocumentID.String()),
				zap.Error(failErr),
			)
		}
		return err
	}

	if err := w.documents.CompleteJob(ctx, job.ID); err != nil {
		log.Error("complete document job failed",
			zap.String("job_id", job.ID.String()),
			zap.Error(err),
		)
		return err
	}

	log.Info("document job completed",
		zap.String("job_id", job.ID.String()),
		zap.String("document_id", job.DocumentID.String()),
	)
	return nil
}
