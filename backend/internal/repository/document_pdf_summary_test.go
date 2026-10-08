package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/model"
)

func TestPDFSummaryCannotBeOverwrittenByAnInactiveJob(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	doc := createDocumentRepositoryTestDocument(t, db)
	job := model.DocumentJob{DocumentID: doc.ID, JobType: "process_document", Status: "running"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	repo := NewDocumentRepository(db)
	ctx := context.Background()
	summary := []byte(`{"totalPages":2,"textPages":1,"pagesWithoutText":[2]}`)
	if err := repo.SavePDFTextSummary(ctx, doc.ID, job.ID, summary); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"cancelled", "completed", "failed"} {
		if err := db.Model(&job).Update("status", status).Error; err != nil {
			t.Fatal(err)
		}
		if err := repo.SavePDFTextSummary(ctx, doc.ID, job.ID, []byte(`{"totalPages":99}`)); !errors.Is(err, ErrDocumentJobCancelled) {
			t.Fatalf("%s: error = %v", status, err)
		}
		stored, err := repo.FindByID(ctx, doc.ID)
		if err != nil || string(stored.PDFTextSummary) != string(summary) {
			t.Fatalf("inactive job overwrote summary: %#v, %v", stored, err)
		}
	}
}

func TestReprocessClearsPDFSummaryForSingleAndBatchRequests(t *testing.T) {
	for _, batch := range []bool{false, true} {
		db := newDocumentRepositoryTestDB(t)
		doc := createDocumentRepositoryTestDocument(t, db)
		if err := db.Model(&doc).Update("pdf_text_summary", `{"totalPages":2,"textPages":1,"pagesWithoutText":[2]}`).Error; err != nil {
			t.Fatal(err)
		}
		repo := NewDocumentRepository(db)
		ctx := context.Background()
		if batch {
			if err := repo.QueueBatchReprocess(ctx, []uuid.UUID{doc.ID}, doc.UploaderID); err != nil {
				t.Fatal(err)
			}
		} else if _, _, err := repo.QueueReprocess(ctx, doc.ID, doc.UploaderID); err != nil {
			t.Fatal(err)
		}
		stored, err := repo.FindByID(ctx, doc.ID)
		if err != nil || len(stored.PDFTextSummary) != 0 || stored.Status != "uploaded" {
			t.Fatalf("reprocess retained old summary: %#v, %v", stored, err)
		}
	}
}
