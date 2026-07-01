package job

import (
	"context"
	"time"

	"go.uber.org/zap"

	"rag/backend/internal/document/processor"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
)

type Worker struct {
	documents *repository.DocumentRepository
	processor *processor.Processor
	logger    *zap.Logger
	interval  time.Duration
}

func NewWorker(
	documents *repository.DocumentRepository,
	processor *processor.Processor,
	logger *zap.Logger,
) *Worker {
	return &Worker{
		documents: documents,
		processor: processor,
		logger:    logger,
		interval:  3 * time.Second,
	}
}

func (w *Worker) Start(ctx context.Context) {
	w.logger.Info("document worker started")

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
	for {
		job, err := w.documents.ClaimPendingJob(ctx)
		if err != nil {
			w.logger.Error("claim document job failed", zap.Error(err))
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
		message := err.Error()
		w.logger.Error("document job failed",
			zap.String("job_id", job.ID.String()),
			zap.String("document_id", job.DocumentID.String()),
			zap.Error(err),
		)
		_ = w.documents.UpdateStatus(ctx, job.DocumentID, "failed", message)
		_ = w.documents.FailJob(ctx, job.ID, message)
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
