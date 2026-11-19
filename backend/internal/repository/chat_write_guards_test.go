package repository

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/model"
)

func TestChatRepositoryRejectsWritesAfterArchiving(t *testing.T) {
	for _, operation := range []string{"create", "create-batch", "create-snapshot", "replace", "add-scope"} {
		t.Run(operation, func(t *testing.T) {
			ctx := context.Background()
			db := newChatRepositoryTestDB(t)
			repo := NewChatRepository(db)
			user := model.User{Username: "archive-write-" + uuid.NewString(), PasswordHash: "hash"}
			if err := db.Create(&user).Error; err != nil {
				t.Fatal(err)
			}
			base := model.KnowledgeBase{Name: "Archive writes", OwnerID: user.ID}
			if err := db.Create(&base).Error; err != nil {
				t.Fatal(err)
			}
			session := model.ChatSession{UserID: user.ID, KnowledgeBaseID: base.ID, Title: "Archive writes"}
			if err := repo.CreateSession(ctx, &session); err != nil {
				t.Fatal(err)
			}
			question := &model.ChatMessage{SessionID: session.ID, Role: "user", Content: "original question"}
			answer := &model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "original answer"}
			if err := repo.CreateMessages(ctx, question, answer); err != nil {
				t.Fatal(err)
			}
			before, err := repo.ListMessages(ctx, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := repo.ArchiveSession(ctx, session.ID, time.Now()); err != nil {
				t.Fatal(err)
			}
			late := &model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "late answer"}
			switch operation {
			case "create":
				err = repo.CreateMessage(ctx, late)
			case "create-batch":
				err = repo.CreateMessages(ctx, late)
			case "create-snapshot":
				err = repo.CreateMessagesIfUnchanged(ctx, []uuid.UUID{question.ID, answer.ID}, late)
			case "replace":
				edited := &model.ChatMessage{ID: question.ID, SessionID: session.ID, Role: "user", Content: "changed question"}
				err = repo.ReplaceMessageTail(ctx, session.ID, question.ID, nil, []uuid.UUID{answer.ID}, edited, late)
			case "add-scope":
				err = repo.AddSessionKnowledgeBases(ctx, &session, []model.ChatSessionKnowledgeBase{{KnowledgeBaseID: base.ID}})
			}
			if err == nil {
				t.Fatal("content write succeeded after archive had committed")
			}
			after, err := repo.ListMessages(ctx, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("rejected archived write changed saved messages")
			}
			var links int64
			if err := db.Model(&model.ChatSessionKnowledgeBase{}).Where("session_id = ?", session.ID).Count(&links).Error; err != nil {
				t.Fatal(err)
			}
			if links != 0 {
				t.Fatal("rejected archived write registered an additional source")
			}
		})
	}
}
