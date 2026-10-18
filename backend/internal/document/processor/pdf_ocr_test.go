package processor

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"gorm.io/datatypes"
	"kbchat/backend/internal/document/ocr"
	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/splitter"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

type optionPDFParser struct {
	parse func(context.Context, parser.ParseOptions) (parser.ParsedDocument, error)
}

func (p optionPDFParser) ParseDocument(string, string) (parser.ParsedDocument, error) {
	panic("expected context/options parser")
}
func (p optionPDFParser) ParseDocumentWithOptions(ctx context.Context, _ string, _ string, options parser.ParseOptions) (parser.ParsedDocument, error) {
	return p.parse(ctx, options)
}

func TestOCRPublicationAndFailedReprocessKeepMatchingSnapshot(t *testing.T) {
	page := 2
	parsed := parser.ParsedDocument{FileType: "pdf", Segments: []parser.Segment{{Content: "已识别的正式文字", PageNumber: &page, TextSource: "ocr"}}, PDFTextSummary: &parser.PDFTextSummary{TotalPages: 2, TextPages: 1, PagesWithoutText: []int{1}, OCR: &parser.PDFOCRSummary{Status: "completed", TotalPages: 2, CompletedPages: 2, Pages: []int{2}}}}
	f := newProcessorTestFixture(t, "pdf")
	p := New(f.documents, f.chunks, structuredParser{document: parsed}, splitter.New(100, 10), cardinalityEmbedder{})
	if err := p.Process(context.Background(), &f.job); err != nil {
		t.Fatal(err)
	}
	chunks, err := f.chunks.ListByDocument(context.Background(), f.document.ID)
	if err != nil || len(chunks) != 1 || !strings.Contains(string(chunks[0].Metadata), `"textSource":"ocr"`) || *chunks[0].PageNumber != 2 {
		t.Fatalf("chunks %+v %v", chunks, err)
	}
	snapshot, err := f.documents.PDFSnapshot(context.Background(), f.document.ID)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := parser.DecodePDFSnapshot(snapshot)
	if err != nil || restored.Segments[0].Content != chunks[0].Content {
		t.Fatal(err, restored)
	}
	// A new parse may produce different text, but a failed embed must publish neither.
	if err := f.db.Model(&model.DocumentJob{}).Where("id = ?", f.job.ID).Update("status", "running").Error; err != nil {
		t.Fatal(err)
	}
	parsed.Segments[0].Content = "不应发布的新文字"
	p = New(f.documents, f.chunks, structuredParser{document: parsed}, splitter.New(100, 10), cardinalityEmbedder{delta: -1})
	if err := p.Process(context.Background(), &f.job); !errors.Is(err, ErrEmbeddingFailed) {
		t.Fatal(err)
	}
	next, err := f.documents.PDFSnapshot(context.Background(), f.document.ID)
	if err != nil || string(next) != string(snapshot) {
		t.Fatal("failed reprocess replaced snapshot", err)
	}
	retained, err := f.chunks.ListByDocument(context.Background(), f.document.ID)
	if err != nil || len(retained) != 1 || retained[0].ID != chunks[0].ID {
		t.Fatal("failed reprocess replaced chunks", err)
	}
}

func TestOCRFailureSummaryIsSavedWithoutPublishingPartialText(t *testing.T) {
	f := newProcessorTestFixture(t, "pdf")
	summary := &parser.PDFTextSummary{TotalPages: 2, TextPages: 0, PagesWithoutText: []int{1, 2}, OCR: &parser.PDFOCRSummary{Status: "timeout", TotalPages: 2, Pages: []int{}}}
	p := New(f.documents, f.chunks, optionPDFParser{parse: func(context.Context, parser.ParseOptions) (parser.ParsedDocument, error) {
		return parser.ParsedDocument{FileType: "pdf", PDFTextSummary: summary}, ocr.ErrTimeout
	}}, splitter.New(100, 10), cardinalityEmbedder{})
	if err := p.Process(context.Background(), &f.job); ClassifyError(err) != ErrorCodeOCRTimeout || !IsPermanent(err) {
		t.Fatal(err)
	}
	d, err := f.documents.FindByID(context.Background(), f.document.ID)
	if err != nil {
		t.Fatal(err)
	}
	var saved parser.PDFTextSummary
	if json.Unmarshal(d.PDFTextSummary, &saved) != nil || saved.OCR.Status != "timeout" {
		t.Fatal(string(d.PDFTextSummary))
	}
	if snapshot, err := f.documents.PDFSnapshot(context.Background(), f.document.ID); err != nil || len(snapshot) != 0 {
		t.Fatal("failed OCR published snapshot", err)
	}
}

func TestCorrectedPDFReprocessAlwaysUsesImmutableBaseline(t *testing.T) {
	f := newProcessorTestFixture(t, "pdf")
	baseline := datatypes.JSON(`{"version":1,"totalPages":2,"pages":[{"pageNumber":1,"content":"原生正文"},{"pageNumber":2,"content":"人工校正后的中文","textSource":"ocr_corrected"}]}`)
	if err := f.db.Create(&model.DocumentPDFCorrection{DocumentID: f.document.ID, Content: baseline}).Error; err != nil {
		t.Fatal(err)
	}
	p := New(f.documents, f.chunks, optionPDFParser{parse: func(context.Context, parser.ParseOptions) (parser.ParsedDocument, error) {
		t.Fatal("corrected PDF reran OCR/parser")
		return parser.ParsedDocument{}, nil
	}}, splitter.New(100, 10), cardinalityEmbedder{})
	for i := 0; i < 2; i++ {
		if err := f.db.Model(&model.DocumentJob{}).Where("id = ?", f.job.ID).Update("status", "running").Error; err != nil {
			t.Fatal(err)
		}
		if err := p.Process(context.Background(), &f.job); err != nil {
			t.Fatal(err)
		}
		rows, err := f.chunks.ListByDocument(context.Background(), f.document.ID)
		if err != nil || len(rows) != 2 {
			t.Fatal(err, rows)
		}
		if rows[1].Content != "人工校正后的中文" || *rows[1].PageNumber != 2 || !strings.Contains(string(rows[1].Metadata), "ocr_corrected") {
			t.Fatal("correction source lost", rows[1])
		}
	}
}

func TestCancellingOCRInterruptsCurrentPageAndRetainsSnapshot(t *testing.T) {
	f := newProcessorTestFixture(t, "pdf")
	old := datatypes.JSON(`{"version":1,"totalPages":1,"pages":[{"pageNumber":1,"content":"original","textSource":"ocr"}]}`)
	if err := f.db.Create(&model.DocumentPDFSnapshot{DocumentID: f.document.ID, Content: old}).Error; err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	p := New(f.documents, f.chunks, optionPDFParser{parse: func(ctx context.Context, options parser.ParseOptions) (parser.ParsedDocument, error) {
		summary := &parser.PDFTextSummary{TotalPages: 1, PagesWithoutText: []int{1}, OCR: &parser.PDFOCRSummary{Status: "running", TotalPages: 1, Pages: []int{}}}
		if err := options.OnPDFProgress(summary); err != nil {
			return parser.ParsedDocument{}, err
		}
		close(started)
		<-ctx.Done()
		return parser.ParsedDocument{}, ctx.Err()
	}}, splitter.New(100, 10), cardinalityEmbedder{})
	result := make(chan error, 1)
	go func() { result <- p.Process(context.Background(), &f.job) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("OCR did not start")
	}
	// The repository state is the cancellation authority, even during a long subprocess.
	if err := f.db.Model(&model.DocumentJob{}).Where("id = ?", f.job.ID).Update("status", "cancelled").Error; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, repository.ErrDocumentJobCancelled) {
			t.Fatal(err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("OCR cancellation was not observed")
	}
	retained, err := f.documents.PDFSnapshot(context.Background(), f.document.ID)
	if err != nil || string(retained) != string(old) {
		t.Fatal("cancel replaced published snapshot", err)
	}
}
