package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/model"
)

func TestDocumentUploadReceiptReplaysAndRejectsChangedInput(t *testing.T) {
	s := newWorkspaceTestServices(t)
	ctx := context.Background()
	actor := createWorkspaceUser(t, s.db, "upload-receipt")
	kb := createWorkspaceKB(t, s.db, actor.ID, uuid.Nil, "receipt", "private", time.Now())
	key := uuid.NewString()
	options := DocumentUploadOptions{RequestID: key}
	upload := func(name, text string, opts DocumentUploadOptions) (string, error) {
		doc, err := s.documents.UploadWithOptions(ctx, actor.ID, kb.ID, createUploadFile(t, name, text), opts)
		if doc == nil {
			return "", err
		}
		return doc.ID, err
	}
	first, err := upload("spec.md", "original", options)
	if err != nil {
		t.Fatal(err)
	}
	second, err := upload("spec.md", "original", options)
	if err != nil || first != second {
		t.Fatalf("replay %q %q: %v", first, second, err)
	}
	for _, change := range []struct {
		name, body string
		opts       DocumentUploadOptions
	}{
		{"spec.md", "different", options}, {"renamed.md", "original", options},
		{"spec.md", "original", DocumentUploadOptions{RequestID: key, SourcePath: "folder/spec.md"}},
		{"spec.md", "original", DocumentUploadOptions{RequestID: key, AllowDuplicate: true}},
	} {
		_, err = upload(change.name, change.body, change.opts)
		var app *apperror.Error
		if !errors.As(err, &app) || app.Code != "DOCUMENT_UPLOAD_REQUEST_CONFLICT" {
			t.Fatalf("changed input: %v", err)
		}
	}
	var docs, jobs, receipts int64
	s.db.Model(&model.Document{}).Count(&docs)
	s.db.Model(&model.DocumentJob{}).Count(&jobs)
	s.db.Model(&model.DocumentUploadReceipt{}).Count(&receipts)
	if docs != 1 || jobs != 1 || receipts != 1 || countUploadedFiles(t, s.uploadRoot) != 1 {
		t.Fatalf("duplicated resources: %d/%d/%d", docs, jobs, receipts)
	}
	result, err := s.documents.UploadResult(ctx, actor.ID, kb.ID, uuid.MustParse(key))
	if err != nil || result.Status != "committed" || result.Document.ID != first {
		t.Fatalf("receipt: %+v %v", result, err)
	}
	missing, err := s.documents.UploadResult(ctx, actor.ID, kb.ID, uuid.New())
	if err != nil || missing.Status != "notFound" {
		t.Fatalf("unknown key: %+v %v", missing, err)
	}
}

func TestDocumentReplacementReceiptReplaysBeforeSupersededCheck(t *testing.T) {
	s := newWorkspaceTestServices(t)
	ctx := context.Background()
	actor := createWorkspaceUser(t, s.db, "replace-receipt")
	kb := createWorkspaceKB(t, s.db, actor.ID, uuid.Nil, "receipt", "private", time.Now())
	original, err := s.documents.Upload(ctx, actor.ID, kb.ID, createUploadFile(t, "spec.md", "v1"))
	if err != nil {
		t.Fatal(err)
	}
	opts := DocumentUploadOptions{RequestID: uuid.NewString()}
	first, err := s.documents.Replace(ctx, actor.ID, uuid.MustParse(original.ID), createUploadFile(t, "spec.md", "v2"), opts)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.documents.Replace(ctx, actor.ID, uuid.MustParse(original.ID), createUploadFile(t, "spec.md", "v2"), opts)
	if err != nil || second.ID != first.ID {
		t.Fatalf("replacement replay: %+v %v", second, err)
	}
	var count int64
	s.db.Model(&model.Document{}).Count(&count)
	if count != 2 || countUploadedFiles(t, s.uploadRoot) != 2 {
		t.Fatal("replacement created another revision")
	}
}

func TestDocumentReplacementRollbackDoesNotPublishVersionLink(t *testing.T) {
	s := newWorkspaceTestServices(t)
	ctx := context.Background()
	actor := createWorkspaceUser(t, s.db, "replace-rollback")
	kb := createWorkspaceKB(t, s.db, actor.ID, uuid.Nil, "receipt", "private", time.Now())
	original, err := s.documents.Upload(ctx, actor.ID, kb.ID, createUploadFile(t, "spec.md", "v1"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.db.Callback().Create().Before("gorm:create").Register("fail-new-job", func(tx *gorm.DB) {
		if tx.Statement.Table == "document_jobs" {
			tx.AddError(errors.New("injected job failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer s.db.Callback().Create().Remove("fail-new-job")
	_, err = s.documents.Replace(ctx, actor.ID, uuid.MustParse(original.ID), createUploadFile(t, "spec.md", "v2"), DocumentUploadOptions{RequestID: uuid.NewString()})
	if err == nil {
		t.Fatal("expected failure")
	}
	old, err := s.documents.Get(ctx, actor.ID, uuid.MustParse(original.ID))
	if err != nil || old.SupersededByID != nil {
		t.Fatalf("old version was modified: %+v %v", old, err)
	}
	var docs, receipts int64
	s.db.Model(&model.Document{}).Count(&docs)
	s.db.Model(&model.DocumentUploadReceipt{}).Count(&receipts)
	if docs != 1 || receipts != 0 {
		t.Fatalf("failed transaction leaked rows: %d/%d", docs, receipts)
	}
}

func TestDocumentUploadReceiptDoesNotResurrectDeletedDocumentOrLeakAcrossUsers(t *testing.T) {
	s := newWorkspaceTestServices(t)
	ctx := context.Background()
	actor := createWorkspaceUser(t, s.db, "receipt-owner")
	other := createWorkspaceUser(t, s.db, "receipt-other")
	kb := createWorkspaceKB(t, s.db, actor.ID, uuid.Nil, "receipt", "private", time.Now())
	opts := DocumentUploadOptions{RequestID: uuid.NewString()}
	doc, err := s.documents.UploadWithOptions(ctx, actor.ID, kb.ID, createUploadFile(t, "spec.md", "v1"), opts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.documents.UploadResult(ctx, other.ID, kb.ID, uuid.MustParse(opts.RequestID)); err == nil {
		t.Fatal("private receipt leaked")
	}
	if err := s.documents.Delete(ctx, actor.ID, uuid.MustParse(doc.ID)); err != nil {
		t.Fatal(err)
	}
	result, err := s.documents.UploadResult(ctx, actor.ID, kb.ID, uuid.MustParse(opts.RequestID))
	if err != nil || result.Status != "unavailable" || result.Document != nil {
		t.Fatalf("deleted receipt: %+v %v", result, err)
	}
	_, err = s.documents.UploadWithOptions(ctx, actor.ID, kb.ID, createUploadFile(t, "spec.md", "v1"), opts)
	var app *apperror.Error
	if !errors.As(err, &app) || app.Code != "DOCUMENT_UPLOAD_RESULT_UNAVAILABLE" {
		t.Fatalf("deleted document recreated: %v", err)
	}
}
