package repository

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/model"
	"os"
	"testing"
)

func TestPostgresMultiChatScopeMigration(t *testing.T) {
	db, _ := newPostgresConcurrencyTestDBs(t)
	// Replace only the minimal fixture table in this test's isolated schema.
	if err := db.Exec("DROP TABLE chat_session_knowledge_bases").Error; err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../migrations/030_chat_session_knowledge_bases.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := db.Exec(string(migration)).Error; err != nil {
			t.Fatal(err)
		}
	}
	owner, a, b, sid := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	insertPostgresRecycleFixture(t, db, owner, a)
	if err := db.Exec("INSERT INTO knowledge_bases(id,owner_id,name) VALUES (?,?,?)", b, owner, "secondary").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO chat_sessions(id,user_id,knowledge_base_id,title) VALUES (?,?,?,?)", sid, owner, a, "multi").Error; err != nil {
		t.Fatal(err)
	}
	link := model.ChatSessionKnowledgeBase{SessionID: sid, KnowledgeBaseID: b}
	if err := db.Create(&link).Error; err != nil {
		t.Fatal(err)
	}
	loaded, err := NewChatRepository(db).FindSessionByIDAndUser(context.Background(), sid, owner)
	if err != nil || loaded == nil || len(loaded.KnowledgeBaseIDs()) != 2 {
		t.Fatalf("load migrated scope: %+v %v", loaded, err)
	}
	if err := db.Exec("DELETE FROM knowledge_bases WHERE id = ?", b).Error; err == nil {
		t.Fatal("FK must prevent silently shrinking scope")
	}
	if err := permanentDeleteChatSessions(db, []uuid.UUID{sid}); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("DELETE FROM knowledge_bases WHERE id = ?", b).Error; err != nil {
		t.Fatal(err)
	}
	var n int64
	db.Model(&model.ChatSessionKnowledgeBase{}).Count(&n)
	if n != 0 {
		t.Fatal("orphan scope links")
	}
}

func TestPostgresAutomaticChatScopeMigration(t *testing.T) {
	db, _ := newPostgresConcurrencyTestDBs(t)
	if err := db.Exec("ALTER TABLE chat_sessions DROP COLUMN scope_mode").Error; err != nil {
		t.Fatal(err)
	}
	owner, kb, sid := uuid.New(), uuid.New(), uuid.New()
	insertPostgresRecycleFixture(t, db, owner, kb)
	if err := db.Exec("INSERT INTO chat_sessions(id,user_id,knowledge_base_id,title) VALUES (?,?,?,?)", sid, owner, kb, "old session").Error; err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../migrations/031_chat_automatic_scope.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := db.Exec(string(migration)).Error; err != nil {
			t.Fatal(err)
		}
	}
	var mode string
	if err := db.Raw("SELECT scope_mode FROM chat_sessions WHERE id = ?", sid).Scan(&mode).Error; err != nil || mode != "manual" {
		t.Fatalf("legacy scope changed: %s %v", mode, err)
	}
	if err := db.Exec("UPDATE chat_sessions SET scope_mode = 'auto' WHERE id = ?", sid).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("UPDATE chat_sessions SET scope_mode = 'invalid' WHERE id = ?", sid).Error; err == nil {
		t.Fatal("invalid scope accepted")
	}
}
