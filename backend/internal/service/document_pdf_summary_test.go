package service

import (
	"context"
	"testing"

	"gorm.io/datatypes"

	"kbchat/backend/internal/model"
)

func TestPDFTextSummaryDetailIsAvailableToReadersWithoutDownloadAccess(t *testing.T) {
	f := newDocumentAccessFixture(t)
	if err := f.services.db.Model(&model.Document{}).Where("id = ?", f.document).
		Update("pdf_text_summary", `{"totalPages":3,"textPages":1,"pagesWithoutText":[2,3]}`).Error; err != nil {
		t.Fatal(err)
	}
	detail, err := f.services.documents.Get(context.Background(), f.viewer, f.document)
	if err != nil || detail.PDFTextSummary == nil || detail.PDFTextSummary.TotalPages != 3 || len(detail.PDFTextSummary.PagesWithoutText) != 2 {
		t.Fatalf("viewer detail: %#v, %v", detail, err)
	}
	_, err = f.services.documents.Download(context.Background(), f.viewer, f.document)
	assertAppError(t, err, "FORBIDDEN")
}

func TestUnknownOrInvalidPDFSummaryNeverClaimsCompleteExtraction(t *testing.T) {
	for _, raw := range []string{"", "null", `{}`, `{"totalPages":3,"textPages":1,"pagesWithoutText":[3,2]}`, `{"totalPages":3,"textPages":2,"pagesWithoutText":[4]}`, `{"totalPages":3,"textPages":3,"pagesWithoutText":[2]}`} {
		if got := documentPDFTextSummary(&model.Document{FileType: "pdf", PDFTextSummary: datatypes.JSON(raw)}); got != nil {
			t.Fatalf("invalid %s became %#v", raw, got)
		}
	}
	full := documentPDFTextSummary(&model.Document{FileType: "pdf", PDFTextSummary: datatypes.JSON(`{"totalPages":3,"textPages":3,"pagesWithoutText":[]}`)})
	if full == nil || full.TextPages != 3 || full.PagesWithoutText == nil {
		t.Fatalf("full extraction: %#v", full)
	}
}

func TestReprocessResponseClearsPreviousPDFSummary(t *testing.T) {
	f := newDocumentAccessFixture(t)
	if err := f.services.db.Model(&model.Document{}).Where("id = ?", f.document).
		Update("pdf_text_summary", `{"totalPages":3,"textPages":1,"pagesWithoutText":[2,3]}`).Error; err != nil {
		t.Fatal(err)
	}
	queued, err := f.services.documents.Reprocess(context.Background(), f.owner, f.document)
	if err != nil || queued.Status != "uploaded" || queued.PDFTextSummary != nil {
		t.Fatalf("reprocess response retained old extraction: %#v, %v", queued, err)
	}
	detail, err := f.services.documents.Get(context.Background(), f.owner, f.document)
	if err != nil || detail.PDFTextSummary != nil {
		t.Fatalf("queued detail retained old extraction: %#v, %v", detail, err)
	}
}
