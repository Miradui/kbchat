package repository

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/model"
)

func TestPostgresFirstQuestionTitleUsesPersistedSnapshot(t *testing.T) {
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
		if err := db.Exec(string(body)).Error; err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	user := model.User{Username: "title-fixture", PasswordHash: "fixture", Role: "user", Status: "active"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	kb := model.KnowledgeBase{OwnerID: user.ID, Name: "title fixture", DocumentVersionPolicy: "all"}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}
	for _, manualTitle := range []string{"", "新会话", "手动标题"} {
		t.Run("manual="+manualTitle, func(t *testing.T) {
			session := model.ChatSession{UserID: user.ID, KnowledgeBaseID: kb.ID, ScopeMode: "manual", Title: "新会话"}
			if err := db.Create(&session).Error; err != nil {
				t.Fatal(err)
			}
			// Reload the persisted microsecond snapshot before generation.
			if err := db.First(&session, "id = ?", session.ID).Error; err != nil {
				t.Fatal(err)
			}
			if manualTitle != "" {
				if err := db.Model(&model.ChatSession{}).Where("id = ?", session.ID).
					Updates(map[string]any{"title": manualTitle, "updated_at": session.UpdatedAt.Add(time.Second)}).Error; err != nil {
					t.Fatal(err)
				}
			}
			question := &model.ChatMessage{SessionID: session.ID, Role: "user", Content: "首问标题"}
			answer := &model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "fixture answer"}
			if err := NewChatRepository(db).CreateMessagesWithTitleIfUnchanged(context.Background(), []uuid.UUID{}, &session, question.Content, question, answer); err != nil {
				t.Fatal(err)
			}
			want := question.Content
			if manualTitle != "" {
				want = manualTitle
			}
			var current model.ChatSession
			if err := db.First(&current, "id = ?", session.ID).Error; err != nil || current.Title != want {
				t.Fatalf("persisted title = %q, want %q; error=%v", current.Title, want, err)
			}
			var count int64
			if err := db.Model(&model.ChatMessage{}).Where("session_id = ?", session.ID).Count(&count).Error; err != nil || count != 2 {
				t.Fatalf("accepted answer lost its message pair: count=%d, error=%v", count, err)
			}
		})
	}
}
