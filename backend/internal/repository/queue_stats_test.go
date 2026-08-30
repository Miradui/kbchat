package repository

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/model"
)

func createQueueStatsJob(t *testing.T, db *gorm.DB, documentID uuid.UUID, status string, createdAt time.Time, lockedAt *time.Time, updatedAt time.Time) model.DocumentJob {
	t.Helper()
	job := model.DocumentJob{
		ID:         uuid.New(),
		DocumentID: documentID,
		JobType:    "process_document",
		Status:     status,
		LockedAt:   lockedAt,
		CreatedAt:  createdAt,
		UpdatedAt:  updatedAt,
	}
	// GORM would overwrite both timestamps with now on create, and the whole point
	// of these fixtures is where they sit relative to the window.
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := db.Model(&model.DocumentJob{}).Where("id = ?", job.ID).
		UpdateColumns(map[string]any{"created_at": createdAt, "updated_at": updatedAt, "locked_at": lockedAt}).Error; err != nil {
		t.Fatalf("backdate job: %v", err)
	}
	return job
}

func TestDocumentQueueStatsCountsStatusesAndOldestTimestamps(t *testing.T) {
	ctx := context.Background()
	db := newDocumentRepositoryTestDB(t)
	document := createDocumentRepositoryTestDocument(t, db)
	repo := NewDocumentRepository(db)

	now := time.Now().UTC().Truncate(time.Second)
	oldestPending := now.Add(-30 * time.Minute)
	lockedAt := now.Add(-10 * time.Minute)

	createQueueStatsJob(t, db, document.ID, "pending", oldestPending, nil, oldestPending)
	createQueueStatsJob(t, db, document.ID, "pending", now.Add(-5*time.Minute), nil, now.Add(-5*time.Minute))
	createQueueStatsJob(t, db, document.ID, "running", now.Add(-time.Hour), &lockedAt, now)
	createQueueStatsJob(t, db, document.ID, "failed", now.Add(-2*time.Hour), nil, now.Add(-90*time.Minute))
	createQueueStatsJob(t, db, document.ID, "completed", now.Add(-3*time.Hour), nil, now.Add(-3*time.Hour))
	createQueueStatsJob(t, db, document.ID, "cancelled", now.Add(-4*time.Hour), nil, now.Add(-4*time.Hour))

	stats, err := repo.QueueStats(ctx, 0)
	if err != nil {
		t.Fatalf("queue stats: %v", err)
	}

	if stats.Pending != 2 || stats.Running != 1 || stats.Failed != 1 ||
		stats.Completed != 1 || stats.Cancelled != 1 {
		t.Fatalf("unexpected status counts: %#v", stats)
	}
	if !stats.OldestPendingAt.Equal(oldestPending) {
		t.Fatalf("oldest pending = %v, want %v", stats.OldestPendingAt, oldestPending)
	}
	// A running job that queued an hour ago but started ten minutes ago is not an
	// hour-old stuck job, so it must be aged from locked_at.
	if !stats.OldestRunningAt.Equal(lockedAt) {
		t.Fatalf("oldest running = %v, want locked_at %v", stats.OldestRunningAt, lockedAt)
	}
}

func TestDocumentQueueStatsFailureRateIsBoundedByTheWindow(t *testing.T) {
	ctx := context.Background()
	db := newDocumentRepositoryTestDB(t)
	document := createDocumentRepositoryTestDocument(t, db)
	repo := NewDocumentRepository(db)

	now := time.Now().UTC().Truncate(time.Second)
	// Inside a one-hour window: one failure, one success.
	createQueueStatsJob(t, db, document.ID, "failed", now.Add(-90*time.Minute), nil, now.Add(-10*time.Minute))
	createQueueStatsJob(t, db, document.ID, "completed", now.Add(-90*time.Minute), nil, now.Add(-20*time.Minute))
	// Outside it: two failures that must not inflate the current rate.
	createQueueStatsJob(t, db, document.ID, "failed", now.Add(-8*time.Hour), nil, now.Add(-7*time.Hour))
	createQueueStatsJob(t, db, document.ID, "failed", now.Add(-9*time.Hour), nil, now.Add(-8*time.Hour))
	// Still queued, so it belongs to neither numerator nor denominator.
	createQueueStatsJob(t, db, document.ID, "pending", now.Add(-time.Minute), nil, now.Add(-time.Minute))

	stats, err := repo.QueueStats(ctx, time.Hour)
	if err != nil {
		t.Fatalf("queue stats: %v", err)
	}

	if stats.TotalInWindow != 2 || stats.FailedInWindow != 1 {
		t.Fatalf("window counts = %d failed of %d, want 1 of 2", stats.FailedInWindow, stats.TotalInWindow)
	}
	if stats.Failed != 3 {
		t.Fatalf("lifetime failed = %d, want 3", stats.Failed)
	}
}

func TestDocumentQueueStatsOnEmptyQueueReportsZeroTimes(t *testing.T) {
	ctx := context.Background()
	db := newDocumentRepositoryTestDB(t)
	repo := NewDocumentRepository(db)

	stats, err := repo.QueueStats(ctx, time.Hour)
	if err != nil {
		t.Fatalf("queue stats: %v", err)
	}

	if stats.Pending != 0 || stats.TotalInWindow != 0 {
		t.Fatalf("unexpected counts on an empty queue: %#v", stats)
	}
	// The API layer turns these into nulls; an epoch date would render as 1970 on
	// the diagnostics page.
	if !stats.OldestPendingAt.IsZero() || !stats.OldestRunningAt.IsZero() {
		t.Fatalf("expected zero timestamps on an empty queue: %#v", stats)
	}
}

func TestDocumentQueueStatsIgnoresOtherJobTypes(t *testing.T) {
	ctx := context.Background()
	db := newDocumentRepositoryTestDB(t)
	document := createDocumentRepositoryTestDocument(t, db)
	repo := NewDocumentRepository(db)

	other := model.DocumentJob{
		ID:         uuid.New(),
		DocumentID: document.ID,
		JobType:    "some_future_job",
		Status:     "pending",
	}
	if err := db.Create(&other).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	stats, err := repo.QueueStats(ctx, time.Hour)
	if err != nil {
		t.Fatalf("queue stats: %v", err)
	}
	if stats.Pending != 0 {
		t.Fatalf("expected other job types excluded, got %#v", stats)
	}
}

func TestStorageCleanupQueueStatsReportsBacklogAndRetries(t *testing.T) {
	ctx := context.Background()
	db := newDocumentRepositoryTestDB(t)
	repo := NewStorageCleanupRepository(db)

	now := time.Now().UTC().Truncate(time.Second)
	oldestAttempt := now.Add(-2 * time.Hour)
	lockedAt := now.Add(-time.Minute)

	jobs := []model.StorageCleanupJob{
		{ID: uuid.New(), StoragePath: "a", NextAttemptAt: &oldestAttempt, RetryCount: 3},
		{ID: uuid.New(), StoragePath: "b", NextAttemptAt: &now},
		{ID: uuid.New(), StoragePath: "c", LockedAt: &lockedAt, RetryCount: 1},
	}
	for i := range jobs {
		if err := db.Create(&jobs[i]).Error; err != nil {
			t.Fatalf("create cleanup job: %v", err)
		}
	}

	stats, err := repo.QueueStats(ctx)
	if err != nil {
		t.Fatalf("cleanup queue stats: %v", err)
	}

	if stats.Backlog != 3 || stats.Retrying != 2 || stats.Locked != 1 {
		t.Fatalf("unexpected cleanup stats: %#v", stats)
	}
	if !stats.OldestAttemptAt.Equal(oldestAttempt) {
		t.Fatalf("oldest attempt = %v, want %v", stats.OldestAttemptAt, oldestAttempt)
	}
	if stats.OldestEnqueuedAt.IsZero() {
		t.Fatalf("expected an oldest enqueued timestamp, got zero")
	}
}

func TestStorageCleanupQueueStatsOnEmptyQueue(t *testing.T) {
	ctx := context.Background()
	db := newDocumentRepositoryTestDB(t)
	repo := NewStorageCleanupRepository(db)

	stats, err := repo.QueueStats(ctx)
	if err != nil {
		t.Fatalf("cleanup queue stats: %v", err)
	}
	if stats.Backlog != 0 || !stats.OldestAttemptAt.IsZero() || !stats.OldestEnqueuedAt.IsZero() {
		t.Fatalf("unexpected stats on an empty queue: %#v", stats)
	}
}
