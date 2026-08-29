package repository

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	gormlogger "gorm.io/gorm/logger"

	"kbchat/backend/internal/model"
)

func TestEmptyWorkerQueuesDoNotLogRecordNotFoundErrors(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	var output bytes.Buffer
	quietDB := db.Session(&gorm.Session{Logger: gormlogger.New(log.New(&output, "", 0), gormlogger.Config{
		LogLevel:                  gormlogger.Error,
		IgnoreRecordNotFoundError: false,
	})})
	if job, err := NewDocumentRepository(quietDB).ClaimPendingJob(context.Background()); err != nil || job != nil {
		t.Fatalf("claim empty document queue: job=%#v err=%v", job, err)
	}
	if cleanup, err := NewStorageCleanupRepository(quietDB).ClaimPending(context.Background(), 0); err != nil || cleanup != nil {
		t.Fatalf("claim empty storage cleanup queue: cleanup=%#v err=%v", cleanup, err)
	}
	if strings.Contains(output.String(), "record not found") {
		t.Fatalf("empty worker queues must not emit error logs: %s", output.String())
	}
}

func TestClaimPendingJobLocksDocumentBeforeJob(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "pending"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create pending job: %v", err)
	}
	lockTargets := recordDocumentRepositoryLockTargets(t, db)

	claimed, err := repository.ClaimPendingJob(context.Background())
	if err != nil {
		t.Fatalf("claim pending job: %v", err)
	}
	if claimed == nil || claimed.ID != job.ID {
		t.Fatalf("expected pending job to be claimed, got %#v", claimed)
	}

	want := []string{"documents", "document_jobs"}
	if !reflect.DeepEqual(*lockTargets, want) {
		t.Fatalf("expected aggregate lock order %v, got %v", want, *lockTargets)
	}
}

func TestSoftDeleteCancelsActiveJobAndLeavesRestorableFailedState(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	document.Status = "embedding"
	if err := db.Save(&document).Error; err != nil {
		t.Fatalf("mark document processing: %v", err)
	}
	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create running job: %v", err)
	}

	if err := repository.Delete(context.Background(), &document); err != nil {
		t.Fatalf("soft delete document: %v", err)
	}

	var storedDocument model.Document
	if err := db.Unscoped().First(&storedDocument, "id = ?", document.ID).Error; err != nil {
		t.Fatalf("reload deleted document: %v", err)
	}
	if !storedDocument.DeletedAt.Valid || storedDocument.Status != "failed" {
		t.Fatalf("expected a restorable failed document, got deleted=%v status=%q", storedDocument.DeletedAt.Valid, storedDocument.Status)
	}
	var storedJob model.DocumentJob
	if err := db.First(&storedJob, "id = ?", job.ID).Error; err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if storedJob.Status != "cancelled" {
		t.Fatalf("expected delete to cancel the active job, got %q", storedJob.Status)
	}
}

func TestFinalizeJobLocksDocumentBeforeJob(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create running job: %v", err)
	}
	lockTargets := recordDocumentRepositoryLockTargets(t, db)

	if err := repository.CompleteJob(context.Background(), job.ID); err != nil {
		t.Fatalf("complete job: %v", err)
	}

	want := []string{"documents", "document_jobs"}
	if !reflect.DeepEqual(*lockTargets, want) {
		t.Fatalf("expected aggregate lock order %v, got %v", want, *lockTargets)
	}
}

func TestPermanentDeleteLocksDocumentBeforeDeletingJobs(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create running job: %v", err)
	}
	if err := db.Delete(&document).Error; err != nil {
		t.Fatalf("soft delete document: %v", err)
	}
	lockTargets := recordDocumentRepositoryLockTargets(t, db)

	if err := repository.PermanentDelete(context.Background(), document.ID); err != nil {
		t.Fatalf("permanently delete document: %v", err)
	}

	if len(*lockTargets) == 0 || (*lockTargets)[0] != "documents" {
		t.Fatalf("expected document lock before child deletion, got %v", *lockTargets)
	}
	assertStorageCleanupQueued(t, db, document.StoragePath)
}

func TestEmptyDeletedByOwnerLocksDocumentsBeforeDeletingJobs(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create running job: %v", err)
	}
	if err := db.Delete(&document).Error; err != nil {
		t.Fatalf("soft delete document: %v", err)
	}
	lockTargets := recordDocumentRepositoryLockTargets(t, db)

	if err := repository.EmptyDeletedByOwner(context.Background(), document.UploaderID); err != nil {
		t.Fatalf("empty document recycle bin: %v", err)
	}

	if len(*lockTargets) == 0 || (*lockTargets)[0] != "documents" {
		t.Fatalf("expected document locks before child deletion, got %v", *lockTargets)
	}
	assertStorageCleanupQueued(t, db, document.StoragePath)
}

func TestKnowledgeBasePermanentDeleteLocksKnowledgeBaseThenDocumentsBeforeDeletingJobs(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	if err := db.AutoMigrate(
		&model.DocumentChunk{},
		&model.ChatSession{},
		&model.ChatMessage{},
		&model.KnowledgeBaseMember{},
		&model.KnowledgeBaseFavorite{},
		&model.KnowledgeBaseViewEvent{},
		&model.KnowledgeBaseTag{},
		&model.KnowledgeBaseTagBinding{},
	); err != nil {
		t.Fatalf("migrate permanent-delete dependencies: %v", err)
	}
	document := createDocumentRepositoryTestDocument(t, db)
	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create running job: %v", err)
	}
	if err := db.Delete(&model.KnowledgeBase{ID: document.KnowledgeBaseID}).Error; err != nil {
		t.Fatalf("soft delete knowledge base: %v", err)
	}
	lockTargets := recordDocumentRepositoryLockTargets(t, db)

	if err := NewKnowledgeBaseRepository(db).PermanentDelete(context.Background(), document.KnowledgeBaseID); err != nil {
		t.Fatalf("permanently delete knowledge base: %v", err)
	}

	want := []string{"knowledge_bases", "documents"}
	if !reflect.DeepEqual(*lockTargets, want) {
		t.Fatalf("expected knowledge base then document locks before cascading job deletion, got %v", *lockTargets)
	}
	assertStorageCleanupQueued(t, db, document.StoragePath)
}

func assertStorageCleanupQueued(t *testing.T, db *gorm.DB, storagePath string) {
	t.Helper()
	var count int64
	if err := db.Table("storage_cleanup_jobs").Where("storage_path = ?", storagePath).Count(&count).Error; err != nil {
		t.Fatalf("count storage cleanup jobs: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected one cleanup job for %q, got %d", storagePath, count)
	}
}

func TestClaimPendingJobWaitsForSameDocumentRunningJob(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	running := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	successor := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "pending"}
	if err := db.Create(&running).Error; err != nil {
		t.Fatalf("create running job: %v", err)
	}
	if err := db.Create(&successor).Error; err != nil {
		t.Fatalf("create successor job: %v", err)
	}

	claimed, err := repository.ClaimPendingJob(context.Background())
	if err != nil {
		t.Fatalf("claim while predecessor runs: %v", err)
	}
	if claimed != nil {
		t.Fatalf("expected successor to wait for running predecessor, got %#v", claimed)
	}

	if err := db.Model(&running).Update("status", "completed").Error; err != nil {
		t.Fatalf("complete predecessor: %v", err)
	}
	claimed, err = repository.ClaimPendingJob(context.Background())
	if err != nil {
		t.Fatalf("claim successor: %v", err)
	}
	if claimed == nil || claimed.ID != successor.ID {
		t.Fatalf("expected successor after predecessor completion, got %#v", claimed)
	}
}

func TestClaimPendingJobIgnoresUnsupportedJobTypes(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	unsupported := model.DocumentJob{DocumentID: document.ID, JobType: "unknown_job", Status: "pending"}
	if err := db.Create(&unsupported).Error; err != nil {
		t.Fatalf("create unsupported job: %v", err)
	}

	claimed, err := repository.ClaimPendingJob(context.Background())
	if err != nil {
		t.Fatalf("claim pending job: %v", err)
	}
	if claimed != nil {
		t.Fatalf("expected unsupported job type to remain unclaimed, got %#v", claimed)
	}
}

func TestRecoverRunningJobsIgnoresUnsupportedJobTypes(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	processJob := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	unsupportedJob := model.DocumentJob{DocumentID: document.ID, JobType: "unknown_job", Status: "running"}
	if err := db.Create(&processJob).Error; err != nil {
		t.Fatalf("create process job: %v", err)
	}
	if err := db.Create(&unsupportedJob).Error; err != nil {
		t.Fatalf("create unsupported job: %v", err)
	}

	if err := repository.RecoverRunningJobs(context.Background()); err != nil {
		t.Fatalf("recover running jobs: %v", err)
	}

	if err := db.First(&processJob, "id = ?", processJob.ID).Error; err != nil {
		t.Fatalf("reload process job: %v", err)
	}
	if err := db.First(&unsupportedJob, "id = ?", unsupportedJob.ID).Error; err != nil {
		t.Fatalf("reload unsupported job: %v", err)
	}
	if processJob.Status != "pending" {
		t.Fatalf("expected process job to be recovered, got %q", processJob.Status)
	}
	if unsupportedJob.Status != "running" {
		t.Fatalf("expected unsupported job to remain running, got %q", unsupportedJob.Status)
	}
}

func TestCompleteJobFinalizesDocumentAndJob(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	if err := db.Model(&document).Updates(map[string]any{"status": "embedding", "error_message": "old error"}).Error; err != nil {
		t.Fatalf("prepare document: %v", err)
	}
	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	if err := repository.CompleteJob(context.Background(), job.ID); err != nil {
		t.Fatalf("complete job: %v", err)
	}

	assertDocumentJobTerminalState(t, db, document.ID, job.ID, "completed", "completed", "")
}

func TestCompleteJobIsIdempotentAfterAtomicPublish(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	if err := db.Model(&document).Updates(map[string]any{
		"status":        "completed",
		"error_message": "",
	}).Error; err != nil {
		t.Fatalf("prepare completed document: %v", err)
	}
	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "completed"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create completed job: %v", err)
	}

	if err := repository.CompleteJob(context.Background(), job.ID); err != nil {
		t.Fatalf("complete an already-published job: %v", err)
	}

	assertDocumentJobTerminalState(t, db, document.ID, job.ID, "completed", "completed", "")
}

func TestFailJobFinalizesDocumentAndJob(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	if err := db.Model(&document).Update("status", "embedding").Error; err != nil {
		t.Fatalf("prepare document: %v", err)
	}
	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	if err := repository.FailJob(context.Background(), job.ID, "embedding failed"); err != nil {
		t.Fatalf("fail job: %v", err)
	}

	assertDocumentJobTerminalState(t, db, document.ID, job.ID, "failed", "failed", "embedding failed")
}

func TestCompleteJobRollsBackWhenDocumentFinalizationFails(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	if err := db.Model(&document).Update("status", "embedding").Error; err != nil {
		t.Fatalf("prepare document: %v", err)
	}
	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := db.Exec(`
		CREATE TRIGGER reject_document_completion
		BEFORE UPDATE OF status ON documents
		WHEN NEW.status = 'completed'
		BEGIN
			SELECT RAISE(FAIL, 'document completion rejected');
		END
	`).Error; err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}

	if err := repository.CompleteJob(context.Background(), job.ID); err == nil {
		t.Fatal("expected document finalization failure")
	}

	assertDocumentJobTerminalState(t, db, document.ID, job.ID, "embedding", "running", "")
}

func TestFinalizeJobRejectsStaleCompletedJob(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	if err := db.Model(&document).Update("status", "embedding").Error; err != nil {
		t.Fatalf("prepare successor document state: %v", err)
	}
	staleJob := model.DocumentJob{
		DocumentID: document.ID,
		JobType:    "process_document",
		Status:     "completed",
	}
	if err := db.Create(&staleJob).Error; err != nil {
		t.Fatalf("create stale job: %v", err)
	}

	err := repository.FailJob(context.Background(), staleJob.ID, "late failure")
	if err == nil {
		t.Fatalf("expected stale job error, got %v", err)
	}

	assertDocumentJobTerminalState(t, db, document.ID, staleJob.ID, "embedding", "completed", "")
}

func assertDocumentJobTerminalState(
	t *testing.T,
	db *gorm.DB,
	documentID uuid.UUID,
	jobID uuid.UUID,
	expectedDocumentStatus string,
	expectedJobStatus string,
	expectedError string,
) {
	t.Helper()
	var document model.Document
	if err := db.First(&document, "id = ?", documentID).Error; err != nil {
		t.Fatalf("reload document: %v", err)
	}
	var job model.DocumentJob
	if err := db.First(&job, "id = ?", jobID).Error; err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if document.Status != expectedDocumentStatus || document.ErrorMessage != expectedError {
		t.Fatalf("unexpected document terminal state: status=%q error=%q", document.Status, document.ErrorMessage)
	}
	if job.Status != expectedJobStatus || job.ErrorMessage != expectedError {
		t.Fatalf("unexpected job terminal state: status=%q error=%q", job.Status, job.ErrorMessage)
	}
}

func newDocumentRepositoryTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("get sqlite connection: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(
		&model.User{},
		&model.KnowledgeBase{},
		&model.Document{},
		&model.DocumentJob{},
		&model.StorageCleanupJob{},
		&model.DocumentChunk{},
	); err != nil {
		t.Fatalf("auto migrate document repository fixture: %v", err)
	}
	return db
}

func createDocumentRepositoryTestDocument(t *testing.T, db *gorm.DB) model.Document {
	t.Helper()
	user := model.User{Username: "jobs-" + uuid.NewString(), PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	knowledgeBase := model.KnowledgeBase{Name: "Job Repository", OwnerID: user.ID}
	if err := db.Create(&knowledgeBase).Error; err != nil {
		t.Fatalf("create knowledge base: %v", err)
	}
	document := model.Document{
		KnowledgeBaseID: knowledgeBase.ID,
		UploaderID:      user.ID,
		Filename:        "manual.pdf",
		FileType:        "pdf",
		StoragePath:     "manual.pdf",
		Status:          "completed",
	}
	if err := db.Create(&document).Error; err != nil {
		t.Fatalf("create document: %v", err)
	}
	return document
}

func recordDocumentRepositoryLockTargets(t *testing.T, db *gorm.DB) *[]string {
	t.Helper()
	lockTargets := make([]string, 0, 2)
	callbackName := "test:record-document-repository-lock-targets"
	if err := db.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		forClause, ok := tx.Statement.Clauses["FOR"]
		if !ok {
			return
		}
		locking, ok := forClause.Expression.(clause.Locking)
		if !ok || locking.Strength == "" {
			return
		}
		target := locking.Table.Name
		if target == "" || target == clause.CurrentTable {
			target = tx.Statement.Table
		}
		lockTargets = append(lockTargets, target)
	}); err != nil {
		t.Fatalf("register lock-order callback: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Callback().Query().Remove(callbackName)
	})
	return &lockTargets
}
