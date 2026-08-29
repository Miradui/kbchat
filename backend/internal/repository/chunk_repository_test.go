package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"kbchat/backend/internal/model"
)

func TestChunkRepositoryReplaceByDocumentRollsBackLaterBatchFailure(t *testing.T) {
	fixture := newChunkRepositoryTestFixture(t)
	ctx := context.Background()
	existing := fixture.chunk(fixture.documentA, 0, "existing complete index")
	seed := []model.DocumentChunk{existing}
	if err := fixture.repository.CreateBatch(ctx, seed); err != nil {
		t.Fatalf("seed existing chunk: %v", err)
	}
	existing = seed[0]

	replacements := make([]model.DocumentChunk, 51)
	for index := range replacements {
		replacements[index] = fixture.chunk(fixture.documentA, index, fmt.Sprintf("replacement %02d", index))
		replacements[index].ID = uuid.New()
	}
	replacements[50].ID = replacements[0].ID

	err := fixture.repository.ReplaceByDocument(ctx, fixture.documentA.ID, replacements)
	if err == nil {
		t.Fatal("expected second create batch to fail on duplicate primary key")
	}
	stored, listErr := fixture.repository.ListByDocument(ctx, fixture.documentA.ID)
	if listErr != nil {
		t.Fatalf("list chunks after rollback: %v", listErr)
	}
	if len(stored) != 1 || stored[0].ID != existing.ID || stored[0].Content != existing.Content {
		t.Fatalf("expected old chunks and first replacement batch to roll back, got %#v", stored)
	}
}

func TestChunkRepositoryReplaceByDocumentRejectsChunksForAnotherDocument(t *testing.T) {
	fixture := newChunkRepositoryTestFixture(t)
	ctx := context.Background()
	existing := fixture.chunk(fixture.documentA, 0, "existing complete index")
	seed := []model.DocumentChunk{existing}
	if err := fixture.repository.CreateBatch(ctx, seed); err != nil {
		t.Fatalf("seed existing chunk: %v", err)
	}
	existing = seed[0]

	err := fixture.repository.ReplaceByDocument(ctx, fixture.documentA.ID, []model.DocumentChunk{
		fixture.chunk(fixture.documentB, 0, "wrong document"),
	})
	if err == nil {
		t.Fatal("expected cross-document replacement to be rejected")
	}
	stored, listErr := fixture.repository.ListByDocument(ctx, fixture.documentA.ID)
	if listErr != nil {
		t.Fatalf("list original chunks: %v", listErr)
	}
	if len(stored) != 1 || stored[0].ID != existing.ID {
		t.Fatalf("expected rejected replacement not to touch original chunks, got %#v", stored)
	}
	other, listErr := fixture.repository.ListByDocument(ctx, fixture.documentB.ID)
	if listErr != nil {
		t.Fatalf("list other document chunks: %v", listErr)
	}
	if len(other) != 0 {
		t.Fatalf("expected rejected replacement not to write another document, got %#v", other)
	}
}

func TestChunkRepositoryCreateBatchRejectsMismatchedKnowledgeBase(t *testing.T) {
	fixture := newChunkRepositoryTestFixture(t)
	chunk := fixture.chunk(fixture.documentA, 0, "cross knowledge base")
	chunk.KnowledgeBaseID = fixture.documentB.KnowledgeBaseID

	if err := fixture.repository.CreateBatch(context.Background(), []model.DocumentChunk{chunk}); err == nil {
		t.Fatal("expected mismatched document and knowledge base to be rejected")
	}
}

func TestChunkRepositoryReplaceByDocumentRejectsMismatchedKnowledgeBase(t *testing.T) {
	fixture := newChunkRepositoryTestFixture(t)
	ctx := context.Background()
	existing := fixture.chunk(fixture.documentA, 0, "existing")
	if err := fixture.repository.CreateBatch(ctx, []model.DocumentChunk{existing}); err != nil {
		t.Fatalf("seed existing chunk: %v", err)
	}
	replacement := fixture.chunk(fixture.documentA, 0, "cross knowledge base")
	replacement.KnowledgeBaseID = fixture.documentB.KnowledgeBaseID

	if err := fixture.repository.ReplaceByDocument(ctx, fixture.documentA.ID, []model.DocumentChunk{replacement}); err == nil {
		t.Fatal("expected mismatched document and knowledge base to be rejected")
	}
	stored, err := fixture.repository.ListByDocument(ctx, fixture.documentA.ID)
	if err != nil {
		t.Fatalf("list chunks after rejected replacement: %v", err)
	}
	if len(stored) != 1 || stored[0].Content != "existing" {
		t.Fatalf("expected existing chunk to remain, got %#v", stored)
	}
}

func TestChunkRepositorySearchByVectorUsesPublishedChunksDuringReprocessing(t *testing.T) {
	fixture := newChunkRepositoryTestFixture(t)
	trace := &queryTraceLogger{Interface: logger.Default.LogMode(logger.Silent)}
	repository := NewChunkRepository(fixture.repository.db.Session(&gorm.Session{
		DryRun: true,
		Logger: trace,
	}))

	if _, err := repository.SearchByVector(context.Background(), fixture.documentA.KnowledgeBaseID, []float32{1}, 5); err != nil && !errors.Is(err, gorm.ErrDryRunModeUnsupported) {
		t.Fatalf("build vector search query: %v", err)
	}

	query := strings.ToLower(trace.query)
	if strings.Contains(query, "documents.status") {
		t.Fatalf("expected published chunks to remain searchable across document processing states, got %q", trace.query)
	}
	if !strings.Contains(query, "documents.deleted_at is null") {
		t.Fatalf("expected deleted documents to remain excluded, got %q", trace.query)
	}
	if !strings.Contains(query, "documents.knowledge_base_id") {
		t.Fatalf("expected document ownership to be constrained by knowledge base, got %q", trace.query)
	}
}

type queryTraceLogger struct {
	logger.Interface
	query string
}

func (l *queryTraceLogger) Trace(_ context.Context, _ time.Time, fc func() (string, int64), _ error) {
	l.query, _ = fc()
}

type chunkRepositoryTestFixture struct {
	repository *ChunkRepository
	documentA  model.Document
	documentB  model.Document
}

func newChunkRepositoryTestFixture(t *testing.T) chunkRepositoryTestFixture {
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
		t.Fatalf("auto migrate chunk repository fixture: %v", err)
	}
	user := model.User{Username: "chunks-" + uuid.NewString(), PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	createKnowledgeBase := func(name string) model.KnowledgeBase {
		knowledgeBase := model.KnowledgeBase{Name: name, OwnerID: user.ID}
		if err := db.Create(&knowledgeBase).Error; err != nil {
			t.Fatalf("create knowledge base %s: %v", name, err)
		}
		return knowledgeBase
	}
	knowledgeBaseA := createKnowledgeBase("Chunk Repository A")
	knowledgeBaseB := createKnowledgeBase("Chunk Repository B")
	createDocument := func(knowledgeBase model.KnowledgeBase, filename string) model.Document {
		document := model.Document{
			KnowledgeBaseID: knowledgeBase.ID,
			UploaderID:      user.ID,
			Filename:        filename,
			FileType:        "txt",
			StoragePath:     filename,
			Status:          "completed",
		}
		if err := db.Create(&document).Error; err != nil {
			t.Fatalf("create document %s: %v", filename, err)
		}
		return document
	}
	return chunkRepositoryTestFixture{
		repository: NewChunkRepository(db),
		documentA:  createDocument(knowledgeBaseA, "a.txt"),
		documentB:  createDocument(knowledgeBaseB, "b.txt"),
	}
}

func (f chunkRepositoryTestFixture) chunk(document model.Document, index int, content string) model.DocumentChunk {
	return model.DocumentChunk{
		DocumentID:      document.ID,
		KnowledgeBaseID: document.KnowledgeBaseID,
		ChunkIndex:      index,
		Content:         content,
		Embedding:       pgvector.NewVector([]float32{1}),
	}
}
