package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func TestChatMessageFeedbackPersistsAndIsOwnerScoped(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "feedback-owner")
	other := createWorkspaceUser(t, services.db, "feedback-other")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "feedback kb", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "feedback session")
	userMessage := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "question"}
	assistantMessage := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "answer"}
	if err := services.db.Create(&userMessage).Error; err != nil {
		t.Fatalf("create user message: %v", err)
	}
	if err := services.db.Create(&assistantMessage).Error; err != nil {
		t.Fatalf("create assistant message: %v", err)
	}

	feedback, err := services.chats.SetMessageFeedback(ctx, owner.ID, assistantMessage.ID, "positive")
	if err != nil {
		t.Fatalf("set positive feedback: %v", err)
	}
	if feedback.MessageID != assistantMessage.ID.String() || feedback.Rating != "positive" || feedback.UpdatedAt.IsZero() {
		t.Fatalf("unexpected feedback response: %#v", feedback)
	}

	feedback, err = services.chats.SetMessageFeedback(ctx, owner.ID, assistantMessage.ID, "negative")
	if err != nil {
		t.Fatalf("replace feedback: %v", err)
	}
	if feedback.Rating != "negative" {
		t.Fatalf("expected replacement rating, got %#v", feedback)
	}

	listed, err := services.chats.ListMessages(ctx, owner.ID, session.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	var listedAssistant *dto.ChatMessageResponse
	for i := range listed.Items {
		if listed.Items[i].ID == assistantMessage.ID.String() {
			listedAssistant = &listed.Items[i]
			break
		}
	}
	if listedAssistant == nil || listedAssistant.Feedback == nil || listedAssistant.Feedback.Rating != "negative" {
		t.Fatalf("expected persisted feedback in message list, got %#v", listedAssistant)
	}

	_, err = services.chats.SetMessageFeedback(ctx, other.ID, assistantMessage.ID, "positive")
	assertAppErrorCode(t, err, "RESOURCE_NOT_FOUND")
	_, err = services.chats.SetMessageFeedback(ctx, owner.ID, userMessage.ID, "positive")
	assertAppErrorCode(t, err, "VALIDATION_ERROR")
	_, err = services.chats.SetMessageFeedback(ctx, owner.ID, assistantMessage.ID, "maybe")
	assertAppErrorCode(t, err, "VALIDATION_ERROR")
}

func TestChatQualityOverviewAndNegativeFeedbackAreOwnerScoped(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "quality-owner")
	other := createWorkspaceUser(t, services.db, "quality-other")
	ownedKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	otherKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "机密知识库", "private", time.Now())
	ownedSession := createWorkspaceChatSession(t, services.db, owner.ID, ownedKB.ID, "退货政策")
	otherSession := createWorkspaceChatSession(t, services.db, other.ID, otherKB.ID, "机密会话")

	base := time.Now().UTC().Add(-time.Hour)
	citations, err := json.Marshal([]dto.CitationResponse{{
		DocumentID: "document-id",
		ChunkID:    "chunk-id",
		Filename:   "policy.pdf",
		Content:    "三十天内可退货。",
	}})
	if err != nil {
		t.Fatalf("marshal citations: %v", err)
	}
	fallback, err := json.Marshal(dto.RerankFallbackResponse{Used: true, Reason: "provider timeout"})
	if err != nil {
		t.Fatalf("marshal fallback: %v", err)
	}
	clientRequestID := uuid.New()
	negative, positive := "negative", "positive"
	knowledgeIntent, conversationIntent := chatIntentKnowledgeBase, chatIntentConversation
	returnQuery, invoiceQuery := "如何退货", "需要发票吗"
	returnQueryNorm, invoiceQueryNorm := normalizeRetrievalQuery(returnQuery), normalizeRetrievalQuery(invoiceQuery)
	feedbackAt := base.Add(3 * time.Minute)
	messages := []model.ChatMessage{
		{SessionID: ownedSession.ID, ClientRequestID: &clientRequestID, Role: "user", Content: "如何退货？", CreatedAt: base},
		{SessionID: ownedSession.ID, ClientRequestID: &clientRequestID, Role: "assistant", Content: "请在三十天内申请。", Citations: datatypes.JSON(citations), RerankFallback: datatypes.JSON(fallback), FeedbackRating: &negative, FeedbackUpdatedAt: &feedbackAt, Intent: &knowledgeIntent, RetrievalQuery: &returnQuery, RetrievalQueryNorm: &returnQueryNorm, CreatedAt: base.Add(time.Minute)},
		{SessionID: ownedSession.ID, Role: "user", Content: "需要发票吗？", CreatedAt: base.Add(4 * time.Minute)},
		{SessionID: ownedSession.ID, Role: "assistant", Content: "当前资料无法确认。", FeedbackRating: &positive, FeedbackUpdatedAt: &feedbackAt, Intent: &knowledgeIntent, RetrievalQuery: &invoiceQuery, RetrievalQueryNorm: &invoiceQueryNorm, CreatedAt: base.Add(5 * time.Minute)},
		{SessionID: ownedSession.ID, Role: "assistant", Content: "未评价回答", Intent: &conversationIntent, CreatedAt: base.Add(6 * time.Minute)},
		{SessionID: otherSession.ID, Role: "assistant", Content: "不应泄露", FeedbackRating: &negative, FeedbackUpdatedAt: &feedbackAt, Intent: &knowledgeIntent, CreatedAt: base.Add(7 * time.Minute)},
	}
	if err := services.db.Create(&messages).Error; err != nil {
		t.Fatalf("create quality messages: %v", err)
	}

	overview, err := services.chats.GetQualityOverview(ctx, owner.ID, dto.ChatQualityOverviewQuery{Period: "month"})
	if err != nil {
		t.Fatalf("quality overview: %v", err)
	}
	// withoutCitationsCount only counts knowledge_base answers, so the conversation
	// answer that legitimately carries no citations must not inflate it.
	if overview.AnswerCount != 3 || overview.FeedbackCount != 2 || overview.PositiveFeedbackCount != 1 ||
		overview.NegativeFeedbackCount != 1 || overview.WithoutCitationsCount != 1 ||
		overview.KnowledgeAnswerCount != 2 || overview.UnclassifiedAnswerCount != 0 {
		t.Fatalf("unexpected overview counts: %#v", overview)
	}
	if overview.FeedbackCoverage != float64(2)/3 || overview.PositiveRate != 0.5 || overview.WithoutCitationsRate != 0.5 {
		t.Fatalf("unexpected overview ratios: %#v", overview)
	}

	page, err := services.chats.ListNegativeFeedback(ctx, owner.ID, dto.ChatQualityFeedbackQuery{
		Period:          "month",
		KnowledgeBaseID: &ownedKB.ID,
		HasCitations:    boolPointer(true),
		Page:            1,
		PageSize:        20,
	})
	if err != nil {
		t.Fatalf("list negative feedback: %v", err)
	}
	if page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("expected one owned negative answer, got %#v", page)
	}
	item := page.Items[0]
	if item.MessageID != messages[1].ID.String() || item.Question != "如何退货？" || item.Answer != "请在三十天内申请。" {
		t.Fatalf("unexpected feedback item: %#v", item)
	}
	if len(item.Citations) != 1 || item.Citations[0].Filename != "policy.pdf" || item.RerankFallback == nil || !item.RerankFallback.Used {
		t.Fatalf("expected citations and fallback evidence, got %#v", item)
	}

	withoutCitations, err := services.chats.ListNegativeFeedback(ctx, owner.ID, dto.ChatQualityFeedbackQuery{
		Period:       "month",
		HasCitations: boolPointer(false),
		Page:         1,
		PageSize:     20,
	})
	if err != nil {
		t.Fatalf("list negative feedback without citations: %v", err)
	}
	if withoutCitations.Total != 0 || len(withoutCitations.Items) != 0 {
		t.Fatalf("expected citation filter to exclude the owned negative answer, got %#v", withoutCitations)
	}

	if err := services.db.Delete(&ownedSession).Error; err != nil {
		t.Fatalf("soft delete owned session: %v", err)
	}
	afterDelete, err := services.chats.GetQualityOverview(ctx, owner.ID, dto.ChatQualityOverviewQuery{Period: "month"})
	if err != nil {
		t.Fatalf("quality overview after delete: %v", err)
	}
	if afterDelete.AnswerCount != 0 || afterDelete.FeedbackCoverage != 0 || afterDelete.PositiveRate != 0 {
		t.Fatalf("deleted sessions and empty ratios must be excluded, got %#v", afterDelete)
	}
}

func boolPointer(value bool) *bool { return &value }

func TestChatSessionExportUsesOwnedMessagesAndCitations(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "chat-export-owner")
	other := createWorkspaceUser(t, services.db, "chat-export-other")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "退货政策")
	citations, err := json.Marshal([]dto.CitationResponse{{
		DocumentID: "document-id",
		ChunkID:    "chunk-id",
		Filename:   "policy.pdf",
		PageNumber: intPointer(3),
		Content:    "三十天内可退货。",
	}})
	if err != nil {
		t.Fatalf("marshal citations: %v", err)
	}
	messageTime := time.Now()
	messages := []model.ChatMessage{
		{SessionID: session.ID, Role: "user", Content: "如何退货？", CreatedAt: messageTime.Add(-time.Second)},
		{SessionID: session.ID, Role: "assistant", Content: "请在三十天内申请。", Citations: datatypes.JSON(citations), CreatedAt: messageTime},
	}
	if err := services.db.Create(&messages).Error; err != nil {
		t.Fatalf("create messages: %v", err)
	}

	exported, err := services.chats.ExportSession(ctx, owner.ID, session.ID)
	if err != nil {
		t.Fatalf("export session: %v", err)
	}
	content := string(exported.Content)
	if exported.ContentType != "text/markdown; charset=utf-8" || exported.Filename != "chat-"+session.ID.String()+".md" {
		t.Fatalf("unexpected export metadata: %#v", exported)
	}
	expected := "# 退货政策\n\n" +
		"知识库：产品知识库\n\n" +
		"## 用户\n\n" +
		"如何退货？\n\n" +
		"## 助手\n\n" +
		"请在三十天内申请。\n\n" +
		"### 来源\n\n" +
		"1. policy.pdf（第 3 页）\n" +
		"   三十天内可退货。\n\n"
	if content != expected {
		t.Fatalf("unexpected markdown export:\n%s", content)
	}

	_, err = services.chats.ExportSession(ctx, other.ID, session.ID)
	assertAppErrorCode(t, err, "RESOURCE_NOT_FOUND")
}

func TestProfileAvatarLimitCountsUnicodeCodePoints(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	user := createWorkspaceUser(t, services.db, "unicode-avatar")
	prefix := "https://example.com/"
	valid := prefix + strings.Repeat("名", MaxAvatarURLLength-utf8.RuneCountInString(prefix))
	if _, err := services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{
		DisplayName: "显示名称",
		AvatarURL:   profileAvatarURL(valid),
	}); err != nil {
		t.Fatalf("expected %d-rune avatar URL to pass: %v", MaxAvatarURLLength, err)
	}

	tooLong := valid + "名"
	_, err := services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{
		DisplayName: "显示名称",
		AvatarURL:   profileAvatarURL(tooLong),
	})
	assertAppErrorCode(t, err, "VALIDATION_ERROR")
}

func assertAppErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.Code != code {
		t.Fatalf("expected app error %s, got %v", code, err)
	}
}

func intPointer(value int) *int {
	return &value
}
