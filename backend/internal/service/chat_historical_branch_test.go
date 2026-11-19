package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func TestHistoricalBranchKeepsMessagesAndAllKnowledgeBasePermissions(t *testing.T) {
	f := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, f.db, "historic-owner")
	viewer := createWorkspaceUser(t, f.db, "historic-reader")
	primary := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "primary", "private", time.Now())
	linked := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "linked", "private", time.Now())
	for _, id := range []uuid.UUID{primary.ID, linked.ID} {
		if _, err := f.kbs.AddMember(ctx, owner.ID, id, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
			t.Fatal(err)
		}
	}
	source := createWorkspaceChatSession(t, f.db, viewer.ID, primary.ID, "来源会话")
	sourceMessage := model.ChatMessage{SessionID: source.ID, Role: "assistant", Content: "来源回答"}
	if err := f.db.Create(&sourceMessage).Error; err != nil {
		t.Fatal(err)
	}
	branch := model.ChatSession{UserID: viewer.ID, KnowledgeBaseID: primary.ID, ScopeMode: "auto", Title: "历史分支",
		BranchFromSessionID: &source.ID, BranchFromMessageID: &sourceMessage.ID}
	if err := f.db.Create(&branch).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.db.Create(&model.ChatSessionKnowledgeBase{SessionID: branch.ID, KnowledgeBaseID: linked.ID}).Error; err != nil {
		t.Fatal(err)
	}
	answer := model.ChatMessage{SessionID: branch.ID, Role: "assistant", Content: "已保存的历史回答",
		Citations: datatypes.JSON(`[{"filename":"policy.pdf","content":"当时的依据","textSource":"ocr_corrected"}]`)}
	if err := f.db.Create(&answer).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.chats.DeleteSession(ctx, viewer.ID, source.ID); err != nil {
		t.Fatal(err)
	}
	res, err := f.chats.GetSession(ctx, viewer.ID, branch.ID)
	if err != nil || res.BranchFromSessionID == nil || *res.BranchFromSessionID != source.ID.String() || len(res.KnowledgeBaseIDs) != 2 {
		t.Fatalf("historical branch no longer independently readable: %#v, %v", res, err)
	}
	messages, err := f.chats.ListMessages(ctx, viewer.ID, branch.ID)
	if err != nil || len(messages.Items) != 1 || len(messages.Items[0].Citations) != 1 || messages.Items[0].Content != answer.Content || messages.Items[0].Citations[0].Content != "当时的依据" {
		t.Fatalf("historical transcript changed: %#v, %v", messages, err)
	}
	_, err = f.chats.GetSession(ctx, owner.ID, branch.ID)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	if err := f.kbs.RemoveMember(ctx, owner.ID, linked.ID, viewer.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.chats.GetSession(ctx, viewer.ID, branch.ID)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	if _, err := f.kbs.AddMember(ctx, owner.ID, linked.ID, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.chats.GetSession(ctx, viewer.ID, branch.ID); err != nil {
		t.Fatalf("restored permission must restore historical access: %v", err)
	}
}
