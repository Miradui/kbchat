package repository

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/model"
)

func TestCreateMessagesMakesCreatedAtStrictlyIncreasing(t *testing.T) {
	db := newChatRepositoryTestDB(t)
	repository := NewChatRepository(db)
	user := model.User{Username: "message-order-" + uuid.NewString(), PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	knowledgeBase := model.KnowledgeBase{Name: "Message order", OwnerID: user.ID}
	if err := db.Create(&knowledgeBase).Error; err != nil {
		t.Fatalf("create knowledge base: %v", err)
	}
	session := model.ChatSession{UserID: user.ID, KnowledgeBaseID: knowledgeBase.ID, Title: "Message order"}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	sameTime := time.Date(2026, time.August, 19, 0, 0, 0, 0, time.UTC)
	userMessage := &model.ChatMessage{SessionID: session.ID, Role: "user", Content: "question", CreatedAt: sameTime}
	assistantMessage := &model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "answer", CreatedAt: sameTime}

	if err := repository.CreateMessages(context.Background(), userMessage, assistantMessage); err != nil {
		t.Fatalf("create messages: %v", err)
	}
	if !assistantMessage.CreatedAt.After(userMessage.CreatedAt) {
		t.Fatalf("expected strict message order, user=%s assistant=%s", userMessage.CreatedAt, assistantMessage.CreatedAt)
	}
	listed, err := repository.ListMessages(context.Background(), session.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(listed) != 2 || listed[0].ID != userMessage.ID || listed[1].ID != assistantMessage.ID {
		t.Fatalf("unexpected message order: %#v", listed)
	}
}

func TestEmptyDeletedSessionsLocksVisibleSessionsBeforeDeleting(t *testing.T) {
	db := newChatRepositoryTestDB(t)
	repository := NewChatRepository(db)
	user, _, session := createDeletedChatRepositorySession(t, db)
	lockTargets := recordChatRepositoryLockTargets(t, db)

	if err := repository.EmptyDeletedSessions(context.Background(), user.ID, []string{"viewer", "editor", "manager"}); err != nil {
		t.Fatalf("empty deleted sessions: %v", err)
	}

	if len(*lockTargets) != 1 || (*lockTargets)[0] != "chat_sessions" {
		t.Fatalf("expected chat session rows to be locked before bulk deletion, got %v", *lockTargets)
	}
	var remaining int64
	if err := db.Unscoped().Model(&model.ChatSession{}).Where("id = ?", session.ID).Count(&remaining).Error; err != nil {
		t.Fatalf("count deleted session: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("expected session to be permanently deleted, got %d rows", remaining)
	}
}

func TestPermanentDeleteSessionLocksDeletedSessionBeforeDeleting(t *testing.T) {
	db := newChatRepositoryTestDB(t)
	repository := NewChatRepository(db)
	_, _, session := createDeletedChatRepositorySession(t, db)
	lockTargets := recordChatRepositoryLockTargets(t, db)

	if err := repository.PermanentDeleteSession(context.Background(), session.ID); err != nil {
		t.Fatalf("permanently delete session: %v", err)
	}

	if len(*lockTargets) != 1 || (*lockTargets)[0] != "chat_sessions" {
		t.Fatalf("expected deleted session row to be locked before deletion, got %v", *lockTargets)
	}
}

func TestRestoreSessionRequiresSessionToRemainDeleted(t *testing.T) {
	db := newChatRepositoryTestDB(t)
	repository := NewChatRepository(db)
	_, _, session := createDeletedChatRepositorySession(t, db)

	if err := repository.RestoreSession(context.Background(), session.ID); err != nil {
		t.Fatalf("restore deleted session: %v", err)
	}
	if err := repository.RestoreSession(context.Background(), session.ID); !errors.Is(err, ErrChatSessionNotDeleted) {
		t.Fatalf("expected a stale restore to fail with record not found, got %v", err)
	}
}

func TestArchiveSessionDoesNotOverwriteExistingTimestamp(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	if err := db.AutoMigrate(&model.ChatSession{}, &model.ChatSessionKnowledgeBase{}); err != nil {
		t.Fatalf("migrate chat session: %v", err)
	}
	session := model.ChatSession{
		UserID:          uuid.New(),
		KnowledgeBaseID: uuid.New(),
		Title:           "archive once",
	}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create chat session: %v", err)
	}
	repository := NewChatRepository(db)
	first := time.Date(2026, time.July, 16, 9, 0, 0, 0, time.UTC)
	second := first.Add(time.Hour)

	if err := repository.ArchiveSession(context.Background(), session.ID, first); err != nil {
		t.Fatalf("archive session first time: %v", err)
	}
	if err := repository.ArchiveSession(context.Background(), session.ID, second); err != nil {
		t.Fatalf("archive session second time: %v", err)
	}

	var stored model.ChatSession
	if err := db.First(&stored, "id = ?", session.ID).Error; err != nil {
		t.Fatalf("reload chat session: %v", err)
	}
	if stored.ArchivedAt == nil || !stored.ArchivedAt.Equal(first) {
		t.Fatalf("expected first archive timestamp to remain, got %#v", stored.ArchivedAt)
	}
}

func TestReplaceMessageTailRejectsStaleConversationSnapshot(t *testing.T) {
	db := newChatRepositoryTestDB(t)
	repository := NewChatRepository(db)
	user := model.User{Username: "edit-" + uuid.NewString(), PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	kb := model.KnowledgeBase{Name: "Edit KB", OwnerID: user.ID}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatalf("create knowledge base: %v", err)
	}
	session := model.ChatSession{UserID: user.ID, KnowledgeBaseID: kb.ID, Title: "edit"}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	createdAt := time.Now()
	target := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "old", CreatedAt: createdAt}
	oldAnswer := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "old answer", CreatedAt: createdAt.Add(time.Microsecond)}
	concurrent := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "concurrent question", CreatedAt: createdAt.Add(2 * time.Microsecond)}
	for _, message := range []*model.ChatMessage{&target, &oldAnswer, &concurrent} {
		if err := db.Create(message).Error; err != nil {
			t.Fatalf("create message: %v", err)
		}
	}
	requestID := uuid.New()
	edited := &model.ChatMessage{ID: target.ID, SessionID: session.ID, ClientRequestID: &requestID, Role: "user", Content: "edited"}
	answer := &model.ChatMessage{SessionID: session.ID, ClientRequestID: &requestID, Role: "assistant", Content: "new answer"}
	err := repository.ReplaceMessageTail(context.Background(), session.ID, target.ID, nil, []uuid.UUID{oldAnswer.ID}, edited, answer)
	if !errors.Is(err, ErrChatMessageChanged) {
		t.Fatalf("expected stale tail conflict, got %v", err)
	}
	var stored []model.ChatMessage
	if err := db.Where("session_id = ?", session.ID).Find(&stored).Error; err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(stored) != 3 {
		t.Fatalf("stale edit must preserve all messages, got %#v", stored)
	}
}

func TestCreateMessagesIfUnchangedRejectsStaleConversationSnapshot(t *testing.T) {
	db := newChatRepositoryTestDB(t)
	repository := NewChatRepository(db)
	user := model.User{Username: "send-" + uuid.NewString(), PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	kb := model.KnowledgeBase{Name: "Send KB", OwnerID: user.ID}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatalf("create knowledge base: %v", err)
	}
	session := model.ChatSession{UserID: user.ID, KnowledgeBaseID: kb.ID, Title: "send"}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	first := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "first"}
	concurrent := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "concurrent"}
	if err := db.Create(&first).Error; err != nil {
		t.Fatalf("create first message: %v", err)
	}
	if err := db.Create(&concurrent).Error; err != nil {
		t.Fatalf("create concurrent message: %v", err)
	}
	stale := &model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "stale answer"}
	err := repository.CreateMessagesIfUnchanged(context.Background(), []uuid.UUID{first.ID}, stale)
	if !errors.Is(err, ErrChatMessageChanged) {
		t.Fatalf("expected stale write conflict, got %v", err)
	}
	var count int64
	if err := db.Model(&model.ChatMessage{}).Where("session_id = ?", session.ID).Count(&count).Error; err != nil {
		t.Fatalf("count messages: %v", err)
	}
	if count != 2 {
		t.Fatalf("stale write must not append a message, got %d", count)
	}
}

func newChatRepositoryTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open chat repository test database: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("get chat repository sql database: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(
		&model.User{},
		&model.KnowledgeBase{},
		&model.ChatSession{}, &model.ChatSessionKnowledgeBase{},
		&model.ChatMessage{},
		// The reachability predicate reads the member table, so every query in this
		// fixture needs it even when the test itself has no members.
		&model.KnowledgeBaseMember{},
	); err != nil {
		t.Fatalf("migrate chat repository fixture: %v", err)
	}
	return db
}

func createDeletedChatRepositorySession(
	t *testing.T,
	db *gorm.DB,
) (model.User, model.KnowledgeBase, model.ChatSession) {
	t.Helper()
	user := model.User{Username: "chat-" + uuid.NewString(), PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create chat repository user: %v", err)
	}
	knowledgeBase := model.KnowledgeBase{Name: "Chat Recycle Bin", OwnerID: user.ID}
	if err := db.Create(&knowledgeBase).Error; err != nil {
		t.Fatalf("create chat repository knowledge base: %v", err)
	}
	session := model.ChatSession{
		UserID:          user.ID,
		KnowledgeBaseID: knowledgeBase.ID,
		Title:           "deleted session",
	}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create chat repository session: %v", err)
	}
	message := model.ChatMessage{
		SessionID: session.ID,
		Role:      "assistant",
		Content:   "kept until permanent deletion",
	}
	if err := db.Create(&message).Error; err != nil {
		t.Fatalf("create chat repository message: %v", err)
	}
	if err := db.Delete(&session).Error; err != nil {
		t.Fatalf("soft delete chat repository session: %v", err)
	}
	return user, knowledgeBase, session
}

func recordChatRepositoryLockTargets(t *testing.T, db *gorm.DB) *[]string {
	t.Helper()
	lockTargets := make([]string, 0, 1)
	callbackName := "test:record-chat-repository-lock-targets"
	if err := db.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		forClause, ok := tx.Statement.Clauses["FOR"]
		if !ok {
			return
		}
		locking, ok := forClause.Expression.(clause.Locking)
		if !ok || locking.Strength == "" {
			return
		}
		target := locking.Table.Name
		if target == "" || target == clause.CurrentTable {
			target = tx.Statement.Table
		}
		lockTargets = append(lockTargets, target)
	}); err != nil {
		t.Fatalf("register chat lock callback: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Callback().Query().Remove(callbackName)
	})
	return &lockTargets
}
