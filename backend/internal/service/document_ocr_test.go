package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func TestPDFComparisonReadsSavedTextWithoutRequiringOCREngineOrOriginal(t *testing.T) {
	f := newDocumentAccessFixture(t)
	id := uuid.New()
	doc := model.Document{ID: id, KnowledgeBaseID: f.kbID, UploaderID: f.owner, Filename: "scan.pdf", FileType: "pdf", Status: "completed", StoragePath: "file-does-not-exist.pdf"}
	if err := f.services.db.Create(&doc).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.services.db.Create(&model.DocumentPDFSnapshot{DocumentID: id, Content: datatypes.JSON(`{"version":1,"totalPages":2,"pages":[{"pageNumber":2,"content":"中文识别文本\n第二行","textSource":"ocr"}]}`)}).Error; err != nil {
		t.Fatal(err)
	}
	lines, err := f.services.documents.comparableText(context.Background(), doc)
	if err != nil || len(lines) != 2 || lines[0] != "中文识别文本" {
		t.Fatal(err, lines)
	}
	if _, err := f.services.documents.Compare(context.Background(), f.stranger, id, id); err == nil {
		t.Fatal("OCR snapshot leaked to another user")
	}
}

func TestOCRSourceSurvivesCitationJSONSnapshot(t *testing.T) {
	items := citationsFromSearch([]dto.SearchResultResponse{{TextSource: "ocr", DocumentID: "doc", ChunkID: "chunk", Content: "识别文本"}})
	content, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	var restored []dto.CitationResponse
	if json.Unmarshal(content, &restored) != nil || len(restored) != 1 || restored[0].TextSource != "ocr" {
		t.Fatal(string(content))
	}
}

func TestCancellingOCRStopsProgressInDocumentResponses(t *testing.T) {
	f := newDocumentAccessFixture(t)
	ctx := context.Background()
	summary := datatypes.JSON(`{"totalPages":2,"textPages":1,"pagesWithoutText":[2],"ocr":{"status":"running","totalPages":2,"completedPages":1,"pages":[1]}}`)
	if err := f.services.db.Model(&model.Document{}).Where("id = ?", f.document).Updates(map[string]any{
		"file_type": "pdf", "status": "parsing", "pdf_text_summary": summary,
	}).Error; err != nil {
		t.Fatal(err)
	}
	job := model.DocumentJob{ID: uuid.New(), DocumentID: f.document, JobType: "process_document", Status: "running"}
	if err := f.services.db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	before, err := f.services.documents.Get(ctx, f.owner, f.document)
	if err != nil || before.PDFTextSummary == nil || before.PDFTextSummary.OCR == nil || before.PDFTextSummary.OCR.Status != "running" {
		t.Fatalf("running document: %v, %+v", err, before)
	}
	cancelled, err := f.services.documents.CancelJob(ctx, f.owner, f.document)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := f.services.documents.Get(ctx, f.viewer, f.document)
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range []*dto.DocumentResponse{cancelled, reloaded} {
		if result.JobStatus != "cancelled" || result.PDFTextSummary == nil || result.PDFTextSummary.OCR == nil || result.PDFTextSummary.OCR.Status != "failed" || result.PDFTextSummary.OCR.CompletedPages != 1 {
			t.Fatalf("cancelled document retained running OCR: %+v", result)
		}
	}
}
