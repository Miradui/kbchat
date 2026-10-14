package processor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/splitter"
	"kbchat/backend/internal/model"
)

func TestProcessCSVPublishesRowsWithSourceMetadata(t *testing.T) {
	f := newProcessorTestFixture(t, "csv")
	path := filepath.Join(t.TempDir(), "资料.csv")
	if err := os.WriteFile(path, []byte("名称,说明\n\n甲,\"第一行\n第二行\"\n乙,后续内容\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Model(&model.Document{}).Where("id = ?", f.document.ID).Update("storage_path", path).Error; err != nil {
		t.Fatal(err)
	}
	p := New(f.documents, f.chunks, parser.NewDefaultParser(), splitter.New(100, 10), cardinalityEmbedder{})
	if err := p.Process(context.Background(), &f.job); err != nil {
		t.Fatal(err)
	}
	chunks, err := f.chunks.ListByDocument(context.Background(), f.document.ID)
	if err != nil || len(chunks) != 2 {
		t.Fatalf("published chunks: %#v %v", chunks, err)
	}
	for i, row := range []int{3, 5} {
		metadata := decodeChunkMetadata(t, chunks[i].Metadata)
		table, ok := metadata["table"].(map[string]any)
		if !ok || table["rowStart"] != float64(row) || table["headerRow"] != float64(1) || metadata["fileType"] != "csv" || metadata["startOffset"] != nil {
			t.Fatalf("row provenance lost: %#v", metadata)
		}
		if !strings.Contains(chunks[i].Content, "说明：") || chunks[i].PageNumber != nil {
			t.Fatalf("missing column or invented page: %#v", chunks[i])
		}
		if i == 0 && table["rowEnd"] != float64(4) {
			t.Fatalf("multiline physical row: %#v", table)
		}
	}
	stored, err := f.documents.FindByID(context.Background(), f.document.ID)
	if err != nil || stored.Status != "completed" {
		t.Fatalf("publication not complete: %#v %v", stored, err)
	}
}
