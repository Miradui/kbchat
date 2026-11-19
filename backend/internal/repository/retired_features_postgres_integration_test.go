package repository

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"

	"kbchat/backend/internal/model"
)

func TestPostgresRetiredFeaturesMigrationPreservesHistoricalChatData(t *testing.T) {
	db := newPostgresVectorTestDB(t)
	files, err := filepath.Glob("../../migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	for _, file := range files {
		if filepath.Base(file) >= "049" {
			continue
		}
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Exec(string(body)).Error; err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	user := model.User{Username: "retirement-fixture", PasswordHash: "fixture", Role: "user", Status: "active"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	kb := model.KnowledgeBase{OwnerID: user.ID, Name: "historical", DocumentVersionPolicy: "all"}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}
	source := model.ChatSession{UserID: user.ID, KnowledgeBaseID: kb.ID, ScopeMode: "manual", Title: "source"}
	if err := db.Create(&source).Error; err != nil {
		t.Fatal(err)
	}
	sourceMessage := model.ChatMessage{SessionID: source.ID, Role: "assistant", Content: "source answer"}
	if err := db.Create(&sourceMessage).Error; err != nil {
		t.Fatal(err)
	}
	branch := model.ChatSession{UserID: user.ID, KnowledgeBaseID: kb.ID, ScopeMode: "manual", Title: "historical branch",
		BranchFromSessionID: &source.ID, BranchFromMessageID: &sourceMessage.ID}
	if err := db.Create(&branch).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("UPDATE chat_sessions SET branch_request_id = ? WHERE id = ?", uuid.New(), branch.ID).Error; err != nil {
		t.Fatal(err)
	}
	answer := model.ChatMessage{SessionID: branch.ID, Role: "assistant", Content: "saved answer", Citations: datatypes.JSON(`[{"filename":"policy.md","content":"saved evidence"}]`)}
	if err := db.Create(&answer).Error; err != nil {
		t.Fatal(err)
	}
	// Preserve the database's JSONB representation, which canonicalizes JSON.
	if err := db.First(&answer, "id = ?", answer.ID).Error; err != nil {
		t.Fatal(err)
	}
	bookmark := model.ChatBookmark{MessageID: answer.ID, UserID: user.ID, Note: "saved private note"}
	if err := db.Create(&bookmark).Error; err != nil {
		t.Fatal(err)
	}
	usage := model.ModelUsageRecord{ID: uuid.New(), UserID: user.ID, KnowledgeBaseID: kb.ID, Purpose: "title", Provider: "openai_compatible", Model: "historical-title-model"}
	if err := db.Create(&usage).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO question_templates(id, user_id, title, body) VALUES (?, ?, ?, ?)", uuid.New(), user.ID, "old template", "old personal question").Error; err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile("../../migrations/049_retire_personal_chat_features.sql")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db.Transaction(func(tx *gorm.DB) error { return tx.Exec(string(body)).Error }); err != nil {
			t.Fatal(err)
		}
	}
	if db.Migrator().HasTable("question_templates") || db.Migrator().HasColumn("chat_sessions", "branch_request_id") || db.Migrator().HasIndex("chat_sessions", "idx_chat_branch_request") {
		t.Fatal("retired template storage or branch request metadata remains")
	}
	read, err := NewChatRepository(db).FindSessionByIDAndUser(context.Background(), branch.ID, user.ID)
	if err != nil || read == nil || read.Title != branch.Title || read.BranchFromSessionID == nil || *read.BranchFromSessionID != source.ID {
		t.Fatalf("historical branch changed: %#v, %v", read, err)
	}
	var saved model.ChatMessage
	if err := db.First(&saved, "id = ?", answer.ID).Error; err != nil || saved.Content != answer.Content || string(saved.Citations) != string(answer.Citations) {
		t.Fatalf("historical answer changed: %#v, %v", saved, err)
	}
	var savedBookmark model.ChatBookmark
	if err := db.First(&savedBookmark, "message_id = ?", answer.ID).Error; err != nil || savedBookmark.Note != bookmark.Note {
		t.Fatalf("private note changed: %#v, %v", savedBookmark, err)
	}
	var savedUsage model.ModelUsageRecord
	if err := db.First(&savedUsage, "id = ?", usage.ID).Error; err != nil || savedUsage.Model != usage.Model {
		t.Fatalf("historical cost record changed: %#v, %v", savedUsage, err)
	}
	if err := db.Unscoped().Delete(&source).Error; err != nil {
		t.Fatal(err)
	}
	read, err = NewChatRepository(db).FindSessionByIDAndUser(context.Background(), branch.ID, user.ID)
	if err != nil || read == nil || read.BranchFromSessionID != nil || read.BranchFromMessageID != nil {
		t.Fatalf("source deletion must leave the independent historical branch without dead links: %#v, %v", read, err)
	}
}
