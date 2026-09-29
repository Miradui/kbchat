package processor

import (
	"context"
	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/splitter"
	"kbchat/backend/internal/model"
	"testing"
)

func TestProcessPublishesEmbeddingIdentityOnlyOnSuccess(t *testing.T) {
	for _, dimension := range []int{1, 2} {
		f := newProcessorTestFixture(t, "txt")
		p := New(f.documents, f.chunks, structuredParser{document: parser.ParsedDocument{FileType: "txt", Segments: []parser.Segment{{Content: "content"}}}}, splitter.New(500, 50), cardinalityEmbedder{})
		p.SetEmbeddingIdentity("fixture-embedding", dimension)
		err := p.Process(context.Background(), &f.job)
		var doc model.Document
		if e := f.db.First(&doc, "id = ?", f.document.ID).Error; e != nil {
			t.Fatal(e)
		}
		if dimension == 1 {
			if err != nil || doc.EmbeddingModel == nil || *doc.EmbeddingModel != "fixture-embedding" || doc.EmbeddingDimension == nil || *doc.EmbeddingDimension != 1 {
				t.Fatalf("success: %+v %v", doc, err)
			}
		} else if err == nil || doc.EmbeddingModel != nil || doc.EmbeddingDimension != nil {
			t.Fatalf("failed embedding updated provenance: %+v %v", doc, err)
		}
	}
}
