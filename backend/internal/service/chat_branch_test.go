package service

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"testing"
	"time"
)

func TestChatBranchCopiesExactPrefixOnceAndKeepsAllDependencies(t *testing.T) {
	f := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, f.db, "branch-owner")
	viewer := createWorkspaceUser(t, f.db, "branch-viewer")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "primary", "private", time.Now())
	linked := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "linked", "private", time.Now())
	for _, id := range []uuid.UUID{kb.ID, linked.ID} {
		if _, err := f.kbs.AddMember(ctx, owner.ID, id, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
			t.Fatal(err)
		}
	}
	stamp := time.Now().UTC().Truncate(time.Microsecond)
	source := model.ChatSession{UserID: viewer.ID, KnowledgeBaseID: kb.ID, ScopeMode: "auto", Title: "原会话", ArchivedAt: &stamp}
	if err := f.db.Create(&source).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.db.Create(&model.ChatSessionKnowledgeBase{SessionID: source.ID, KnowledgeBaseID: linked.ID}).Error; err != nil {
		t.Fatal(err)
	}
	rating := "positive"
	requestID := uuid.New()
	messages := []model.ChatMessage{}
	for i, role := range []string{"user", "assistant", "assistant", "user", "assistant"} {
		m := model.ChatMessage{SessionID: source.ID, Role: role, Content: role, CreatedAt: stamp.Add(time.Duration(i) * time.Second)}
		if i == 1 {
			m.ClientRequestID = &requestID
			m.FeedbackRating = &rating
			m.Citations = datatypes.JSON(`[{"content":"来源","filename":"policy.md"}]`)
		}
		if err := f.db.Create(&m).Error; err != nil {
			t.Fatal(err)
		}
		messages = append(messages, m)
	}
	req := dto.CreateChatBranchRequest{MessageID: messages[1].ID.String(), ClientRequestID: uuid.NewString()}
	branch, err := f.chats.CreateBranch(ctx, viewer.ID, source.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	if branch.ID == source.ID.String() || branch.ScopeMode != "auto" || len(branch.KnowledgeBaseIDs) != 2 || branch.ArchivedAt != nil || branch.BranchFromMessageID == nil || *branch.BranchFromMessageID != messages[1].ID.String() {
		t.Fatalf("branch scope: %+v", branch)
	}
	var copies []model.ChatMessage
	if err = f.db.Where("session_id = ?", branch.ID).Order("created_at ASC, id ASC").Find(&copies).Error; err != nil {
		t.Fatal(err)
	}
	if len(copies) != 2 || copies[1].ID == messages[1].ID || copies[1].FeedbackRating != nil || copies[1].ClientRequestID != nil || string(copies[1].Citations) != string(messages[1].Citations) {
		t.Fatalf("copies: %+v", copies)
	}
	repeated, err := f.chats.CreateBranch(ctx, viewer.ID, source.ID, req)
	if err != nil || repeated.ID != branch.ID {
		t.Fatalf("idempotency: %+v %v", repeated, err)
	}
	req.MessageID = messages[2].ID.String()
	_, err = f.chats.CreateBranch(ctx, viewer.ID, source.ID, req)
	assertAppError(t, err, "CHAT_BRANCH_REQUEST_CONFLICT")
	req.ClientRequestID = uuid.NewString()
	_, err = f.chats.CreateBranch(ctx, owner.ID, source.ID, req)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	var count int64
	f.db.Model(&model.ChatMessage{}).Where("session_id = ?", source.ID).Count(&count)
	if count != 5 {
		t.Fatal("source modified")
	}
	if err = f.kbs.RemoveMember(ctx, owner.ID, linked.ID, viewer.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.chats.GetSession(ctx, viewer.ID, uuid.MustParse(branch.ID))
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	_, err = f.chats.CreateBranch(ctx, viewer.ID, source.ID, req)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
}
func TestChatBranchRollsBackPartialCopy(t *testing.T) {
	f := newWorkspaceTestServices(t)
	ctx := context.Background()
	user := createWorkspaceUser(t, f.db, "branch-rollback")
	kb := createWorkspaceKB(t, f.db, user.ID, uuid.Nil, "kb", "private", time.Now())
	session := model.ChatSession{UserID: user.ID, KnowledgeBaseID: kb.ID}
	if err := f.db.Create(&session).Error; err != nil {
		t.Fatal(err)
	}
	m := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "source"}
	if err := f.db.Create(&m).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.db.Callback().Create().Before("gorm:create").Register("branch:fail-copy", func(tx *gorm.DB) {
		if tx.Statement.Table == "chat_messages" {
			tx.AddError(errors.New("copy failed"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer f.db.Callback().Create().Remove("branch:fail-copy")
	_, err := f.chats.CreateBranch(ctx, user.ID, session.ID, dto.CreateChatBranchRequest{MessageID: m.ID.String(), ClientRequestID: uuid.NewString()})
	if err == nil {
		t.Fatal("expected rollback")
	}
	var count int64
	if err = f.db.Model(&model.ChatSession{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("partial branch leaked: %d %v", count, err)
	}
}
