package service

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/model"
)

func TestReplaceCreatesNewRevisionAndSupersedesOld(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "replace-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "replace-kb", "private", time.Now())

	original, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "spec.md", "# Spec\nv1"))
	if err != nil {
		t.Fatalf("upload original: %v", err)
	}

	replacement, err := services.documents.Replace(
		ctx, owner.ID, mustParseUUID(t, original.ID),
		createUploadFile(t, "spec-v2.md", "# Spec\nv2"),
	)
	if err != nil {
		t.Fatalf("replace document: %v", err)
	}
	if replacement.ID == original.ID {
		t.Fatal("expected the replacement to be a new document")
	}
	if replacement.Status != "uploaded" || replacement.JobStatus != "pending" {
		t.Fatalf("expected the replacement to be queued for processing: %#v", replacement)
	}
	if replacement.SupersededByID != nil {
		t.Fatalf("the replacement must not be superseded itself: %#v", replacement.SupersededByID)
	}

	// The old document is kept and linked, not deleted: retrieval keeps working
	// while the replacement is still processing.
	var old model.Document
	if err := services.db.First(&old, "id = ?", original.ID).Error; err != nil {
		t.Fatalf("old document must still exist: %v", err)
	}
	if old.SupersededByID == nil || old.SupersededByID.String() != replacement.ID {
		t.Fatalf("expected the old document to point at the replacement, got %#v", old.SupersededByID)
	}
	if old.SupersededAt == nil {
		t.Fatal("expected supersededAt to be recorded")
	}
	if old.DeletedAt.Valid {
		t.Fatal("replacement must not soft delete the old revision")
	}
}

func TestReplaceQueuesProcessingForTheNewRevision(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "replace-job-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "replace-job-kb", "private", time.Now())

	original, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "runbook.md", "v1"))
	if err != nil {
		t.Fatalf("upload original: %v", err)
	}
	replacement, err := services.documents.Replace(
		ctx, owner.ID, mustParseUUID(t, original.ID),
		createUploadFile(t, "runbook.md", "v2"),
	)
	if err != nil {
		t.Fatalf("replace document: %v", err)
	}

	var job model.DocumentJob
	if err := services.db.
		Where("document_id = ?", replacement.ID).
		First(&job).Error; err != nil {
		t.Fatalf("expected a processing job for the replacement: %v", err)
	}
	if job.JobType != "process_document" || job.Status != "pending" {
		t.Fatalf("unexpected job for the replacement: %#v", job)
	}
}

func TestReplaceAcceptsIdenticalContentWithoutDuplicateError(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "replace-same-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "replace-same-kb", "private", time.Now())

	content := "# Unchanged\nsame bytes"
	original, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "same.md", content))
	if err != nil {
		t.Fatalf("upload original: %v", err)
	}
	// Replacing a file with the same bytes is a deliberate act, so the duplicate
	// check must not stand in the way of it.
	if _, err := services.documents.Replace(
		ctx, owner.ID, mustParseUUID(t, original.ID),
		createUploadFile(t, "same.md", content),
	); err != nil {
		t.Fatalf("replace with identical content: %v", err)
	}
}

func TestReplaceRejectsAlreadySupersededDocument(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "replace-twice-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "replace-twice-kb", "private", time.Now())

	original, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "chain.md", "v1"))
	if err != nil {
		t.Fatalf("upload original: %v", err)
	}
	if _, err := services.documents.Replace(
		ctx, owner.ID, mustParseUUID(t, original.ID),
		createUploadFile(t, "chain.md", "v2"),
	); err != nil {
		t.Fatalf("first replace: %v", err)
	}

	_, err = services.documents.Replace(
		ctx, owner.ID, mustParseUUID(t, original.ID),
		createUploadFile(t, "chain.md", "v3"),
	)
	var appErr *apperror.Error
	if !errors.As(err, &appErr) {
		t.Fatalf("expected apperror replacing a superseded document, got %v", err)
	}
	if appErr.Status != http.StatusConflict || appErr.Code != "DOCUMENT_ALREADY_SUPERSEDED" {
		t.Fatalf("unexpected error: status=%d code=%s", appErr.Status, appErr.Code)
	}
}

func TestReplaceRejectsOtherOwnersDocument(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "replace-real-owner")
	intruder := createWorkspaceUser(t, services.db, "replace-intruder")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "replace-owned-kb", "private", time.Now())

	original, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "private.md", "v1"))
	if err != nil {
		t.Fatalf("upload original: %v", err)
	}
	if _, err := services.documents.Replace(
		ctx, intruder.ID, mustParseUUID(t, original.ID),
		createUploadFile(t, "private.md", "v2"),
	); err == nil {
		t.Fatal("expected replacement by a non-owner to be rejected")
	}

	var stored model.Document
	if err := services.db.First(&stored, "id = ?", original.ID).Error; err != nil {
		t.Fatalf("load document: %v", err)
	}
	if stored.SupersededByID != nil {
		t.Fatal("a rejected replacement must not touch the document")
	}
}

func TestReplaceRejectsUnsupportedFileWithoutWritingAnything(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "replace-invalid-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "replace-invalid-kb", "private", time.Now())

	original, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "valid.md", "v1"))
	if err != nil {
		t.Fatalf("upload original: %v", err)
	}
	filesBefore := countUploadedFiles(t, services.uploadRoot)

	if _, err := services.documents.Replace(
		ctx, owner.ID, mustParseUUID(t, original.ID),
		createUploadFile(t, "payload.exe", "binary"),
	); err == nil {
		t.Fatal("expected an unsupported replacement file to be rejected")
	}
	if got := countUploadedFiles(t, services.uploadRoot); got != filesBefore {
		t.Fatalf("rejected replacement wrote a file: got %d want %d", got, filesBefore)
	}

	var stored model.Document
	if err := services.db.First(&stored, "id = ?", original.ID).Error; err != nil {
		t.Fatalf("load document: %v", err)
	}
	if stored.SupersededByID != nil {
		t.Fatal("a rejected replacement must not supersede the original")
	}
}
