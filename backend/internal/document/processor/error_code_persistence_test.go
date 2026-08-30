package processor

import (
	"context"
	"errors"
	"testing"

	"kbchat/backend/internal/model"
)

// The classification is only useful if it reaches the document, so this walks the
// real repository path rather than asserting on ClassifyError alone.
func TestFailJobWithCodePersistsTheClassificationOnTheDocument(t *testing.T) {
	ctx := context.Background()
	fixture := newProcessorTestFixture(t, "txt")

	if err := fixture.documents.FailJobWithCode(ctx, fixture.job.ID, "parse md: content is not valid UTF-8", ErrorCodeEncodingInvalid); err != nil {
		t.Fatalf("fail job with code: %v", err)
	}

	var document model.Document
	if err := fixture.db.First(&document, "id = ?", fixture.document.ID).Error; err != nil {
		t.Fatalf("load document: %v", err)
	}
	if document.Status != "failed" {
		t.Fatalf("expected failed status, got %q", document.Status)
	}
	if document.ErrorCode == nil || *document.ErrorCode != ErrorCodeEncodingInvalid {
		t.Fatalf("expected error code %q, got %#v", ErrorCodeEncodingInvalid, document.ErrorCode)
	}
	// The raw text still exists for diagnosis; the code is an addition to it.
	if document.ErrorMessage == "" {
		t.Fatal("expected the raw message to be preserved alongside the code")
	}
}

func TestFailJobLeavesTheErrorCodeNull(t *testing.T) {
	ctx := context.Background()
	fixture := newProcessorTestFixture(t, "txt")

	// NULL rather than "": the CHECK constraint in migration 019 admits NULL or one
	// of the closed values, so an empty string would fail on PostgreSQL.
	if err := fixture.documents.FailJob(ctx, fixture.job.ID, "unclassified failure"); err != nil {
		t.Fatalf("fail job: %v", err)
	}

	var errorCode *string
	if err := fixture.db.Raw("SELECT error_code FROM documents WHERE id = ?", fixture.document.ID).Scan(&errorCode).Error; err != nil {
		t.Fatalf("read error code: %v", err)
	}
	if errorCode != nil {
		t.Fatalf("expected NULL error code, got %q", *errorCode)
	}
}

func TestCompletingAJobClearsAPreviousErrorCode(t *testing.T) {
	ctx := context.Background()
	fixture := newProcessorTestFixture(t, "txt")

	if err := fixture.documents.FailJobWithCode(ctx, fixture.job.ID, "embedding failed", ErrorCodeEmbeddingFailed); err != nil {
		t.Fatalf("fail job with code: %v", err)
	}
	// A reprocess that succeeds must not leave the old reason on display.
	retry := model.DocumentJob{
		DocumentID: fixture.document.ID,
		JobType:    "process_document",
		Status:     "running",
	}
	if err := fixture.db.Create(&retry).Error; err != nil {
		t.Fatalf("create retry job: %v", err)
	}
	if err := fixture.documents.CompleteJob(ctx, retry.ID); err != nil {
		t.Fatalf("complete retry job: %v", err)
	}

	var errorCode *string
	if err := fixture.db.Raw("SELECT error_code FROM documents WHERE id = ?", fixture.document.ID).Scan(&errorCode).Error; err != nil {
		t.Fatalf("read error code: %v", err)
	}
	if errorCode != nil {
		t.Fatalf("expected the error code to be cleared on success, got %q", *errorCode)
	}
}

func TestProcessorEmptyContentIsClassifiedNotSwallowed(t *testing.T) {
	// Guards the wiring between the processor's sentinel and the closed set: a
	// scanned PDF with no text layer must not read as "internal error".
	if got := ClassifyError(ErrEmptyContent); got != ErrorCodeEmptyContent {
		t.Fatalf("expected %q, got %q", ErrorCodeEmptyContent, got)
	}
	if got := ClassifyError(errors.New("document contains no extractable text")); got != ErrorCodeInternal {
		t.Fatalf("a look-alike message must not be classified by text, got %q", got)
	}
}
