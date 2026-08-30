package repository

import (
	"context"
	"time"

	"kbchat/backend/internal/model"
)

// DocumentQueueStats summarizes the document processing queue for the
// diagnostics endpoint.
//
// Zero timestamps mean "nothing in that state", which the API layer converts to
// a null rather than an epoch date. FailedInWindow and TotalInWindow are bounded
// by the caller's window so an outage last month stops being reported as a
// current failure rate.
type DocumentQueueStats struct {
	Pending         int64
	Running         int64
	Failed          int64
	Completed       int64
	Cancelled       int64
	OldestPendingAt time.Time
	OldestRunningAt time.Time
	FailedInWindow  int64
	TotalInWindow   int64
}

// StorageCleanupQueueStats summarizes the object cleanup queue. A stalled
// cleanup queue leaks storage silently and is invisible in the product today.
type StorageCleanupQueueStats struct {
	Backlog          int64
	Retrying         int64
	Locked           int64
	OldestAttemptAt  time.Time
	OldestEnqueuedAt time.Time
}

// QueueStats aggregates the document job queue in SQL so the diagnostics page
// stays O(1) regardless of how much history the table holds.
func (r *DocumentRepository) QueueStats(ctx context.Context, window time.Duration) (DocumentQueueStats, error) {
	stats := DocumentQueueStats{}
	db := r.db.WithContext(ctx)

	var statusCounts []struct {
		Status string
		Total  int64
	}
	if err := db.Model(&model.DocumentJob{}).
		Select("status, COUNT(*) AS total").
		Where("job_type = ?", "process_document").
		Group("status").
		Scan(&statusCounts).Error; err != nil {
		return DocumentQueueStats{}, err
	}
	for _, row := range statusCounts {
		switch row.Status {
		case "pending":
			stats.Pending = row.Total
		case "running":
			stats.Running = row.Total
		case "failed":
			stats.Failed = row.Total
		case "completed":
			stats.Completed = row.Total
		case "cancelled":
			stats.Cancelled = row.Total
		}
	}

	oldestPending, err := r.oldestJobTimestamp(ctx, "pending", "created_at")
	if err != nil {
		return DocumentQueueStats{}, err
	}
	stats.OldestPendingAt = oldestPending

	// Running jobs are aged from locked_at, not created_at: a job that waited an
	// hour in the queue and started a second ago is not a stuck job, and reporting
	// it as one would send an operator after the wrong problem.
	oldestRunning, err := r.oldestJobTimestamp(ctx, "running", "locked_at")
	if err != nil {
		return DocumentQueueStats{}, err
	}
	stats.OldestRunningAt = oldestRunning

	if window > 0 {
		// UTC is required, not cosmetic. PostgreSQL compares timestamptz by instant
		// so either zone works there, but SQLite stores timestamps as RFC3339 text
		// and the driver binds a local-zone value with its offset, which then
		// compares lexically against a "Z" value and silently matches nothing.
		since := time.Now().UTC().Add(-window)
		// Counted on updated_at, which is when the job reached its terminal state.
		// created_at would attribute a failure to the hour the document was
		// uploaded, which for a retried job can be well outside the window.
		windowQuery := db.Model(&model.DocumentJob{}).
			Where("job_type = ? AND updated_at >= ?", "process_document", since).
			Where("status IN ?", []string{"completed", "failed"})
		if err := windowQuery.Count(&stats.TotalInWindow).Error; err != nil {
			return DocumentQueueStats{}, err
		}
		if err := db.Model(&model.DocumentJob{}).
			Where("job_type = ? AND updated_at >= ? AND status = ?", "process_document", since, "failed").
			Count(&stats.FailedInWindow).Error; err != nil {
			return DocumentQueueStats{}, err
		}
	}

	return stats, nil
}

// oldestJobTimestamp reads MIN(column) for one status.
//
// The value is scanned as text and parsed rather than into a time.Time:
// PostgreSQL keeps the column type through the aggregate but SQLite loses the
// affinity and returns text, so scanning directly works in production and fails
// in the test suite. parseAggregatedTime is shared with the chat quality queries
// for the same reason.
func (r *DocumentRepository) oldestJobTimestamp(ctx context.Context, status, column string) (time.Time, error) {
	var raw *string
	if err := r.db.WithContext(ctx).
		Model(&model.DocumentJob{}).
		Select("MIN("+column+")").
		Where("job_type = ? AND status = ? AND "+column+" IS NOT NULL", "process_document", status).
		Scan(&raw).Error; err != nil {
		return time.Time{}, err
	}
	if raw == nil {
		return time.Time{}, nil
	}
	return parseAggregatedTime(*raw), nil
}

// QueueStats aggregates the object cleanup queue.
func (r *StorageCleanupRepository) QueueStats(ctx context.Context) (StorageCleanupQueueStats, error) {
	stats := StorageCleanupQueueStats{}
	db := r.db.WithContext(ctx)

	if err := db.Model(&model.StorageCleanupJob{}).Count(&stats.Backlog).Error; err != nil {
		return StorageCleanupQueueStats{}, err
	}
	if err := db.Model(&model.StorageCleanupJob{}).
		Where("retry_count > 0").
		Count(&stats.Retrying).Error; err != nil {
		return StorageCleanupQueueStats{}, err
	}
	if err := db.Model(&model.StorageCleanupJob{}).
		Where("locked_at IS NOT NULL").
		Count(&stats.Locked).Error; err != nil {
		return StorageCleanupQueueStats{}, err
	}

	oldestAttempt, err := r.oldestCleanupTimestamp(ctx, "next_attempt_at")
	if err != nil {
		return StorageCleanupQueueStats{}, err
	}
	stats.OldestAttemptAt = oldestAttempt

	oldestEnqueued, err := r.oldestCleanupTimestamp(ctx, "created_at")
	if err != nil {
		return StorageCleanupQueueStats{}, err
	}
	stats.OldestEnqueuedAt = oldestEnqueued

	return stats, nil
}

func (r *StorageCleanupRepository) oldestCleanupTimestamp(ctx context.Context, column string) (time.Time, error) {
	var raw *string
	if err := r.db.WithContext(ctx).
		Model(&model.StorageCleanupJob{}).
		Select("MIN(" + column + ")").
		Where(column + " IS NOT NULL").
		Scan(&raw).Error; err != nil {
		return time.Time{}, err
	}
	if raw == nil {
		return time.Time{}, nil
	}
	return parseAggregatedTime(*raw), nil
}
