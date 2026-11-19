package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"gorm.io/datatypes"
	"kbchat/backend/internal/document/lexer"
	"kbchat/backend/internal/model"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

func TestPostgresKnowledgeWorkflowMigrationsAndDocumentScope(t *testing.T) {
	db := newPostgresVectorTestDB(t)
	files, err := filepath.Glob("../../migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	for _, file := range files {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if err = db.Exec(string(body)).Error; err != nil {
			t.Fatalf("%s: %v", file, err)
		}
	}
	for _, file := range files {
		if filepath.Base(file) < "044" {
			continue
		}
		body, _ := os.ReadFile(file)
		if err = db.Exec(string(body)).Error; err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("applied %d SQL files and replayed 044 through %s", len(files), filepath.Base(files[len(files)-1]))
	ctx := context.Background()
	user := model.User{Username: "workflow-fixture", PasswordHash: "fixture", Role: "user", Status: "active"}
	if err = db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	kb := model.KnowledgeBase{OwnerID: user.ID, Name: "scope fixture", DocumentVersionPolicy: "current"}
	if err = db.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}
	docs := []model.Document{{KnowledgeBaseID: kb.ID, UploaderID: user.ID, Filename: "old.md", FileType: "md", StoragePath: "fixture-old", Status: "completed"}, {KnowledgeBaseID: kb.ID, UploaderID: user.ID, Filename: "next.md", FileType: "md", StoragePath: "fixture-next", Status: "completed"}}
	vector := make([]float32, 1536)
	vector[0] = 1
	for i := range docs {
		if err = db.Create(&docs[i]).Error; err != nil {
			t.Fatal(err)
		}
		chunk := model.DocumentChunk{DocumentID: docs[i].ID, KnowledgeBaseID: kb.ID, Content: "退款政策", Embedding: pgvector.NewVector(vector), Metadata: datatypes.JSON("{}")}
		if err = db.Create(&chunk).Error; err != nil {
			t.Fatal(err)
		}
		if err = db.Exec("UPDATE document_chunks SET search_vector = ?::tsvector WHERE id = ?", lexer.TSVector(lexer.Tokenize(chunk.Content)), chunk.ID).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err = db.Model(&model.Document{}).Where("id = ?", docs[0].ID).Update("superseded_by_id", docs[1].ID).Error; err != nil {
		t.Fatal(err)
	}
	chunks := NewChunkRepository(db)
	scoped := WithDocumentSearchScope(ctx, []uuid.UUID{docs[0].ID})
	for _, path := range []string{"vector", "exact", "keyword"} {
		var rows []SearchResult
		switch path {
		case "vector":
			rows, err = chunks.SearchByVector(scoped, kb.ID, vector, 1)
		case "exact":
			rows, err = chunks.SearchByVectorExact(scoped, kb.ID, vector, 1)
		default:
			rows, err = chunks.SearchByKeyword(scoped, kb.ID, "退款", 1)
		}
		if err != nil || len(rows) != 1 || rows[0].DocumentID != docs[0].ID {
			t.Fatalf("%s: %+v %v", path, rows, err)
		}
	}
	count, err := chunks.CountVectorSearchable(scoped, kb.ID)
	if err != nil || count != 1 {
		t.Fatal(count, err)
	}
	states, err := NewDocumentRepository(db).VersionStates(ctx, []uuid.UUID{docs[0].ID})
	if err != nil || len(states) != 2 || states[1].ID != docs[1].ID || !states[1].Published {
		t.Fatal(states, err)
	}
	snapshot := model.DocumentPDFSnapshot{DocumentID: docs[1].ID, Content: datatypes.JSON(`{"version":1,"totalPages":1,"pages":[{"pageNumber":1,"content":"机器文本","textSource":"ocr"}]}`)}
	if err = db.Create(&snapshot).Error; err != nil {
		t.Fatal(err)
	}
	saved, err := NewDocumentRepository(db).PDFSnapshot(ctx, docs[1].ID)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(saved)
	// A source snapshot changes after the editor read but before the commit.
	if err = db.Model(&model.DocumentPDFSnapshot{}).Where("document_id = ?", docs[1].ID).Update("content", datatypes.JSON(`{"version":1,"totalPages":1,"pages":[]}`)).Error; err != nil {
		t.Fatal(err)
	}
	next := model.Document{KnowledgeBaseID: kb.ID, UploaderID: user.ID, Filename: "corrected.pdf", FileType: "pdf", StoragePath: "fixture-corrected", Status: "uploaded"}
	job := model.DocumentJob{JobType: "process_document", Status: "pending"}
	err = NewDocumentRepository(db).CommitUpload(ctx, &next, &job, user.ID, nil, &docs[1].ID, PDFCorrectionWrite{Content: saved, SourceRevision: hex.EncodeToString(sum[:])})
	if !errors.Is(err, ErrPDFCorrectionConflict) {
		t.Fatalf("stale correction committed: %v", err)
	}
	var created int64
	db.Model(&model.Document{}).Where("id = ?", next.ID).Count(&created)
	if created != 0 {
		t.Fatal("conflict left revision")
	}
	session := model.ChatSession{UserID: user.ID, KnowledgeBaseID: kb.ID, ScopeMode: "manual", DocumentScope: datatypes.JSON(`[]`)}
	if err = db.Create(&session).Error; err != nil {
		t.Fatal(err)
	}
	item := model.EvaluationCase{ID: uuid.New(), KnowledgeBaseID: kb.ID, CreatedBy: user.ID, Question: "退款", RequiredKeywords: datatypes.JSON(`[]`)}
	if err = db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	issue := model.ChatQualityIssue{UserID: user.ID, SessionID: session.ID, QuestionKey: "fixture", Question: "退款", Status: "open", EvaluationCaseID: &item.ID}
	if err = db.Create(&issue).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Delete(&item).Error; err != nil {
		t.Fatal(err)
	}
	read, err := NewChatRepository(db).QualityIssue(ctx, user.ID, session.ID, "fixture")
	if err != nil || read.EvaluationCaseID != nil {
		t.Fatal("case FK", read, err)
	}
	rating := "negative"
	msg := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "answer", FeedbackRating: &rating, CreatedAt: time.Now().UTC().Add(-time.Minute)}
	if err = db.Create(&msg).Error; err != nil {
		t.Fatal(err)
	}
	overview, err := NewChatRepository(db).GetQualityOverview(ctx, ChatQualityFilter{Scope: "personal", ActorID: user.ID, StartAt: time.Now().UTC().Add(-time.Hour), EndAt: time.Now().UTC()})
	if err != nil || overview.AnswerCount != 1 {
		t.Fatal("quality JSONB scope", overview, err)
	}
}
