package processor

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/splitter"
	"kbchat/backend/internal/model"
)

func TestPDFSummarySurvivesEmptyContentAndEmbeddingFailure(t *testing.T) {
	page := 1
	for _, test := range []struct {
		name    string
		parsed  parser.ParsedDocument
		wantErr error
	}{
		{"no text", parser.ParsedDocument{FileType: "pdf", PDFTextSummary: &parser.PDFTextSummary{TotalPages: 2, TextPages: 0, PagesWithoutText: []int{1, 2}}}, ErrEmptyContent},
		{"embedding failure", parser.ParsedDocument{FileType: "pdf", Segments: []parser.Segment{{Content: "readable page", PageNumber: &page}}, PDFTextSummary: &parser.PDFTextSummary{TotalPages: 2, TextPages: 1, PagesWithoutText: []int{2}}}, ErrEmbeddingFailed},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newProcessorTestFixture(t, "pdf")
			processor := New(f.documents, f.chunks, structuredParser{document: test.parsed}, splitter.New(100, 10), cardinalityEmbedder{delta: -1})
			if err := processor.Process(context.Background(), &f.job); !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v", err)
			}
			document, err := f.documents.FindByID(context.Background(), f.document.ID)
			if err != nil {
				t.Fatal(err)
			}
			var summary parser.PDFTextSummary
			if err := json.Unmarshal(document.PDFTextSummary, &summary); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(&summary, test.parsed.PDFTextSummary) {
				t.Fatalf("summary = %#v", summary)
			}
			chunks, err := f.chunks.ListByDocument(context.Background(), f.document.ID)
			if err != nil || len(chunks) != 0 {
				t.Fatalf("failed processing published chunks: %#v, %v", chunks, err)
			}
		})
	}
}

type failedPDFParser struct{}

func (failedPDFParser) ParseDocument(string, string) (parser.ParsedDocument, error) {
	return parser.ParsedDocument{}, parser.ErrCorruptFile
}

func TestParsingFailureClearsPreviousPDFSummary(t *testing.T) {
	f := newProcessorTestFixture(t, "pdf")
	if err := f.db.Model(&model.Document{}).Where("id = ?", f.document.ID).
		Update("pdf_text_summary", `{"totalPages":2,"textPages":1,"pagesWithoutText":[2]}`).Error; err != nil {
		t.Fatal(err)
	}
	processor := New(f.documents, f.chunks, failedPDFParser{}, splitter.New(100, 10), cardinalityEmbedder{})
	if err := processor.Process(context.Background(), &f.job); !errors.Is(err, parser.ErrCorruptFile) {
		t.Fatalf("error = %v", err)
	}
	document, err := f.documents.FindByID(context.Background(), f.document.ID)
	if err != nil || len(document.PDFTextSummary) != 0 {
		t.Fatalf("stale summary after parsing failure: %#v, %v", document, err)
	}
}
