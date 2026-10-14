package repository

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"kbchat/backend/internal/model"
)

func TestPostgresChatHistoryKeysetAndIndexMigration(t *testing.T) {
	db := newPostgresVectorTestDB(t)
	if err := db.Exec(`CREATE TABLE chat_messages(id UUID PRIMARY KEY, session_id UUID NOT NULL, role TEXT, content TEXT, created_at TIMESTAMPTZ NOT NULL)`).Error; err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../migrations/033_chat_message_history_index.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := db.Exec(string(migration)).Error; err != nil {
			t.Fatal(err)
		}
	}
	sid := uuid.New()
	items := make([]model.ChatMessage, 24)
	for i := range items {
		role := "assistant"
		if i%4 == 0 {
			role = "user"
		}
		items[i] = model.ChatMessage{ID: uuid.MustParse(fmt.Sprintf("00000000-0000-0000-0000-%012d", i+1)), SessionID: sid, Role: role, Content: fmt.Sprint(i), CreatedAt: time.Date(2026, 10, 8, 0, 0, 0, 123456000, time.UTC)}
	}
	if err := db.Select("id", "session_id", "role", "content", "created_at").Create(&items).Error; err != nil {
		t.Fatal(err)
	}
	r := NewChatRepository(db)
	query := ChatHistoryQuery{Limit: 5}
	for i := 0; i < 3; i++ {
		page, err := r.ListMessagePage(context.Background(), sid, query)
		if err != nil || len(page.Items) != 8 || page.Items[0].ID != items[16-8*i].ID || page.HasMore != (i < 2) {
			t.Fatalf("page %d: %+v %v", i, page, err)
		}
		refresh, err := r.ListMessagePage(context.Background(), sid, ChatHistoryQuery{Limit: 5, Since: page.NextCursor})
		if err != nil || len(refresh.Items) != 8*(i+1) {
			t.Fatalf("refresh: %+v %v", refresh, err)
		}
		query.Before, query.Revision = page.NextCursor, page.Revision
	}
	window, err := r.ListMessagePage(context.Background(), sid, ChatHistoryQuery{Limit: 1, Around: &items[9].ID})
	if err != nil || len(window.Items) != 4 || window.Items[0].ID != items[8].ID || !window.HasMore || !window.HasNewer {
		t.Fatalf("around: %+v %v", window, err)
	}
	next, err := r.ListMessagePage(context.Background(), sid, ChatHistoryQuery{Limit: 5, After: window.NewerCursor, Revision: window.Revision})
	if err != nil || len(next.Items) != 8 || next.Items[0].ID != items[12].ID || !next.HasNewer {
		t.Fatalf("after: %+v %v", next, err)
	}
}
