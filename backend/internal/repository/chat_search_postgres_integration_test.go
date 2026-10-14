package repository

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
)

func TestPostgresChatSearchLiteralAndRevokedDependency(t *testing.T) {
	db, _ := newPostgresConcurrencyTestDBs(t)
	for _, sql := range []string{
		"ALTER TABLE chat_messages ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now()",
		"ALTER TABLE chat_sessions ADD COLUMN archived_at TIMESTAMPTZ",
		"ALTER TABLE knowledge_base_members ADD COLUMN role TEXT",
	} {
		if err := db.Exec(sql).Error; err != nil {
			t.Fatal(err)
		}
	}
	user, kb, extra, sid, message := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	insertPostgresRecycleFixture(t, db, user, kb)
	if err := db.Exec("INSERT INTO knowledge_bases(id, owner_id, name) VALUES (?,?,?)", extra, uuid.New(), "shared").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO knowledge_base_members(knowledge_base_id,user_id,role) VALUES (?,?,'viewer')", extra, user).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO chat_sessions(id,user_id,knowledge_base_id,title,archived_at) VALUES (?,?,?,'history',now())", sid, user, kb).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO chat_session_knowledge_bases(session_id,knowledge_base_id) VALUES (?,?)", sid, extra).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO chat_messages(id,session_id,role,content) VALUES (?,?,'assistant',?)", message, sid, "中文 A+B 100%_! résumé").Error; err != nil {
		t.Fatal(err)
	}
	r := NewChatRepository(db)
	for _, term := range []string{"a+b", "100%_!", "中文", "RÉSUMÉ"} {
		items, total, err := r.SearchMessages(context.Background(), user, []string{"viewer"}, dto.ChatMessageSearchQuery{Q: term, Page: 1, PageSize: 20})
		if err != nil || total != 1 || len(items) != 1 || items[0].MessageID != message {
			t.Fatalf("search %q: %d %+v %v", term, total, items, err)
		}
	}
	if err := db.Exec("DELETE FROM knowledge_base_members WHERE knowledge_base_id=? AND user_id=?", extra, user).Error; err != nil {
		t.Fatal(err)
	}
	items, total, err := r.SearchMessages(context.Background(), user, []string{"viewer"}, dto.ChatMessageSearchQuery{Q: "A+B", Page: 1, PageSize: 20})
	if err != nil || total != 0 || len(items) != 0 {
		t.Fatalf("revoked search: %d %+v %v", total, items, err)
	}
}
