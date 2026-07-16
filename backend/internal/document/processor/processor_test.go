package processor

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"rag/backend/internal/document/parser"
	"rag/backend/internal/document/splitter"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
)

type structuredParser struct {
	document parser.ParsedDocument
}

func (p structuredParser) ParseDocument(_ string, _ string) (parser.ParsedDocument, error) {
	return p.document, nil
}

type cardinalityEmbedder struct {
	delta int
}

func (e cardinalityEmbedder) EmbedTexts(_ context.Context, texts []string) ([][]float32, error) {
	count := len(texts) + e.delta
	if count < 0 {
		count = 0
	}
	vectors := make([][]float32, count)
	for index := range vectors {
		vectors[index] = []float32{float32(index + 1)}
	}
	return vectors, nil
}

type lateMismatchEmbedder struct {
	delta int
	calls int
}

func (e *lateMismatchEmbedder) EmbedTexts(_ context.Context, texts []string) ([][]float32, error) {
	e.calls++
	count := len(texts)
	if e.calls == 2 {
		count += e.delta
	}
	if count < 0 {
		count = 0
	}
	vectors := make([][]float32, count)
	for index := range vectors {
		vectors[index] = []float32{float32(index + 1)}
	}
	return vectors, nil
}

type processorTestFixture struct {
	documents *repository.DocumentRepository
	chunks    *repository.ChunkRepository
	document  model.Document
}

func TestBuildChunkMetadataMergesSplitterMetadata(t *testing.T) {
	metadataBytes, err := buildChunkMetadata(splitter.Chunk{
		Metadata: map[string]any{
			"source":        "splitter",
			"headingPath":   []string{"Product Guide", "Permissions"},
			"structureType": "paragraph",
			"startOffset":   42,
			"endOffset":     128,
		},
	})
	if err != nil {
		t.Fatalf("build chunk metadata: %v", err)
	}

	var metadata map[string]any
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
		t.Fatalf("unmarshal metadata: %v", err)
	}

	if metadata["source"] != "document_processor" {
		t.Fatalf("expected document processor source to be preserved, got %#v", metadata["source"])
	}
	if metadata["structureType"] != "paragraph" {
		t.Fatalf("expected structure type metadata, got %#v", metadata["structureType"])
	}

	headingPath, ok := metadata["headingPath"].([]any)
	if !ok {
		t.Fatalf("expected heading path array metadata, got %#v", metadata["headingPath"])
	}
	if len(headingPath) != 2 || headingPath[0] != "Product Guide" || headingPath[1] != "Permissions" {
		t.Fatalf("unexpected heading path metadata: %#v", headingPath)
	}
	if metadata["startOffset"] == nil || metadata["endOffset"] == nil {
		t.Fatalf("expected offset metadata, got %#v", metadata)
	}
}

func TestValidateEmbeddingCountRejectsProviderCardinalityMismatch(t *testing.T) {
	tests := []struct {
		name     string
		expected int
		actual   int
		wantErr  bool
	}{
		{name: "matching vectors", expected: 2, actual: 2, wantErr: false},
		{name: "missing vector", expected: 2, actual: 1, wantErr: true},
		{name: "extra vector", expected: 1, actual: 2, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateEmbeddingCount(tt.expected, tt.actual)
			if !tt.wantErr {
				if err != nil {
					t.Fatalf("expected matching batch to pass, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected embedding cardinality mismatch error")
			}
			if !strings.Contains(err.Error(), "embedding provider returned") {
				t.Fatalf("expected actionable provider error, got %q", err)
			}
		})
	}
}

func TestProcessPersistsStructuredPDFPages(t *testing.T) {
	pageOne := 1
	pageThree := 3
	parsed := parser.ParsedDocument{
		FileType: "pdf",
		Segments: []parser.Segment{
			{Content: "first physical page", PageNumber: &pageOne},
			{Content: "third physical page", PageNumber: &pageThree},
		},
	}
	fixture := newProcessorTestFixture(t, "pdf")
	processor := New(
		fixture.documents,
		fixture.chunks,
		structuredParser{document: parsed},
		splitter.New(100, 10),
		cardinalityEmbedder{},
	)

	if err := processor.Process(context.Background(), &model.DocumentJob{DocumentID: fixture.document.ID}); err != nil {
		t.Fatalf("process PDF: %v", err)
	}

	chunks, err := fixture.chunks.ListByDocument(context.Background(), fixture.document.ID)
	if err != nil {
		t.Fatalf("list PDF chunks: %v", err)
	}
	if len(chunks) != 2 {
		t.Fatalf("expected one stored chunk per non-empty PDF page, got %#v", chunks)
	}
	for index, expectedPage := range []int{1, 3} {
		chunk := chunks[index]
		if chunk.PageNumber == nil || *chunk.PageNumber != expectedPage {
			t.Fatalf("expected physical page %d at chunk %d, got %#v", expectedPage, index, chunk)
		}
		metadata := decodeChunkMetadata(t, chunk.Metadata)
		if metadata["fileType"] != "pdf" || metadata["pageNumber"] != float64(expectedPage) {
			t.Fatalf("expected stored PDF metadata for page %d, got %#v", expectedPage, metadata)
		}
	}
}

func TestProcessLeavesTerminalStatusForWorker(t *testing.T) {
	fixture := newProcessorTestFixture(t, "txt")
	processor := New(
		fixture.documents,
		fixture.chunks,
		structuredParser{document: parser.ParsedDocument{
			FileType: "txt",
			Segments: []parser.Segment{{Content: "content"}},
		}},
		splitter.New(100, 10),
		cardinalityEmbedder{},
	)

	if err := processor.Process(context.Background(), &model.DocumentJob{DocumentID: fixture.document.ID}); err != nil {
		t.Fatalf("process document: %v", err)
	}
	document, err := fixture.documents.FindByID(context.Background(), fixture.document.ID)
	if err != nil || document == nil {
		t.Fatalf("reload document: document=%#v err=%v", document, err)
	}
	if document.Status != "embedding" {
		t.Fatalf("expected worker to own terminal status, got %q", document.Status)
	}
}

func TestProcessSelectsSplitterStrategyFromParsedFileType(t *testing.T) {
	tests := []struct {
		name               string
		fileType           string
		content            string
		wantHeadingPathLen int
		wantLiteral        string
	}{
		{
			name:        "plain text keeps markdown syntax literal",
			fileType:    "txt",
			content:     "# literal heading\n- literal list\nvalue | is | literal",
			wantLiteral: "# literal heading",
		},
		{
			name:               "markdown preserves heading structure",
			fileType:           "md",
			content:            "# Product Guide\nbody text",
			wantHeadingPathLen: 1,
			wantLiteral:        "Product Guide\nbody text",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newProcessorTestFixture(t, tt.fileType)
			parsed := parser.ParsedDocument{
				FileType: tt.fileType,
				Segments: []parser.Segment{{Content: tt.content}},
			}
			processor := New(
				fixture.documents,
				fixture.chunks,
				structuredParser{document: parsed},
				splitter.New(100, 10),
				cardinalityEmbedder{},
			)

			if err := processor.Process(context.Background(), &model.DocumentJob{DocumentID: fixture.document.ID}); err != nil {
				t.Fatalf("process %s: %v", tt.fileType, err)
			}
			chunks, err := fixture.chunks.ListByDocument(context.Background(), fixture.document.ID)
			if err != nil || len(chunks) != 1 {
				t.Fatalf("expected one stored %s chunk, chunks=%#v err=%v", tt.fileType, chunks, err)
			}
			if !strings.Contains(chunks[0].Content, tt.wantLiteral) {
				t.Fatalf("expected %q in stored %s content %q", tt.wantLiteral, tt.fileType, chunks[0].Content)
			}
			metadata := decodeChunkMetadata(t, chunks[0].Metadata)
			if metadata["fileType"] != tt.fileType {
				t.Fatalf("expected %s metadata, got %#v", tt.fileType, metadata)
			}
			headingPathLength := 0
			if headingPath := metadata["headingPath"]; headingPath != nil {
				values, ok := headingPath.([]any)
				if !ok {
					t.Fatalf("expected heading path array or null, got %#v", headingPath)
				}
				headingPathLength = len(values)
			}
			if headingPathLength != tt.wantHeadingPathLen {
				t.Fatalf("expected heading path length %d, got %#v", tt.wantHeadingPathLen, metadata["headingPath"])
			}
		})
	}
}

func TestProcessDoesNotWriteEmbeddingCardinalityMismatch(t *testing.T) {
	for _, delta := range []int{-1, 1} {
		t.Run(fmt.Sprintf("delta_%d", delta), func(t *testing.T) {
			fixture := newProcessorTestFixture(t, "txt")
			parsed := parser.ParsedDocument{
				FileType: "txt",
				Segments: []parser.Segment{{Content: "alpha beta"}},
			}
			processor := New(
				fixture.documents,
				fixture.chunks,
				structuredParser{document: parsed},
				splitter.New(100, 10),
				cardinalityEmbedder{delta: delta},
			)

			err := processor.Process(context.Background(), &model.DocumentJob{DocumentID: fixture.document.ID})
			if err == nil || !strings.Contains(err.Error(), "embedding provider returned") {
				t.Fatalf("expected cardinality mismatch error, got %v", err)
			}
			chunks, listErr := fixture.chunks.ListByDocument(context.Background(), fixture.document.ID)
			if listErr != nil {
				t.Fatalf("list chunks after mismatch: %v", listErr)
			}
			if len(chunks) != 0 {
				t.Fatalf("expected mismatched embedding batch not to be stored, got %#v", chunks)
			}
		})
	}
}

func TestProcessPreservesExistingChunksWhenLaterEmbeddingBatchMismatches(t *testing.T) {
	for _, delta := range []int{-1, 1} {
		t.Run(fmt.Sprintf("delta_%d", delta), func(t *testing.T) {
			fixture := newProcessorTestFixture(t, "txt")
			ctx := context.Background()
			existing := model.DocumentChunk{
				DocumentID:      fixture.document.ID,
				KnowledgeBaseID: fixture.document.KnowledgeBaseID,
				ChunkIndex:      0,
				Content:         "existing complete index",
				Embedding:       pgvector.NewVector([]float32{1}),
			}
			if err := fixture.chunks.CreateBatch(ctx, []model.DocumentChunk{existing}); err != nil {
				t.Fatalf("seed existing chunk: %v", err)
			}

			segments := make([]parser.Segment, embeddingBatchSize+1)
			for index := range segments {
				segments[index] = parser.Segment{Content: fmt.Sprintf("new segment %02d", index)}
			}
			embedder := &lateMismatchEmbedder{delta: delta}
			processor := New(
				fixture.documents,
				fixture.chunks,
				structuredParser{document: parser.ParsedDocument{FileType: "txt", Segments: segments}},
				splitter.New(100, 10),
				embedder,
			)

			err := processor.Process(ctx, &model.DocumentJob{DocumentID: fixture.document.ID})
			if err == nil || !strings.Contains(err.Error(), "embedding provider returned") {
				t.Fatalf("expected later cardinality mismatch, got %v", err)
			}
			if embedder.calls != 2 {
				t.Fatalf("expected mismatch on second embedding batch, got %d calls", embedder.calls)
			}
			chunks, listErr := fixture.chunks.ListByDocument(ctx, fixture.document.ID)
			if listErr != nil {
				t.Fatalf("list chunks after later mismatch: %v", listErr)
			}
			if len(chunks) != 1 || chunks[0].Content != existing.Content {
				t.Fatalf("expected existing complete index to remain untouched, got %#v", chunks)
			}
		})
	}
}

func newProcessorTestFixture(t *testing.T, fileType string) processorTestFixture {
	t.Helper()

	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("get sqlite connection: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := db.AutoMigrate(
		&model.User{},
		&model.KnowledgeBase{},
		&model.Document{},
		&model.DocumentChunk{},
	); err != nil {
		t.Fatalf("auto migrate processor fixture: %v", err)
	}

	user := model.User{Username: "processor-" + uuid.NewString(), PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create processor user: %v", err)
	}
	knowledgeBase := model.KnowledgeBase{Name: "Processor Test", OwnerID: user.ID}
	if err := db.Create(&knowledgeBase).Error; err != nil {
		t.Fatalf("create processor knowledge base: %v", err)
	}
	document := model.Document{
		KnowledgeBaseID: knowledgeBase.ID,
		UploaderID:      user.ID,
		Filename:        "fixture." + fileType,
		FileType:        fileType,
		StoragePath:     "unused-by-structured-parser",
		Status:          "uploaded",
	}
	if err := db.Create(&document).Error; err != nil {
		t.Fatalf("create processor document: %v", err)
	}

	return processorTestFixture{
		documents: repository.NewDocumentRepository(db),
		chunks:    repository.NewChunkRepository(db),
		document:  document,
	}
}

func decodeChunkMetadata(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var metadata map[string]any
	if err := json.Unmarshal(raw, &metadata); err != nil {
		t.Fatalf("decode chunk metadata: %v", err)
	}
	return metadata
}
