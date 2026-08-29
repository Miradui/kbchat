package service

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"

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
	feedbackAt := base.Add(3 * time.Minute)
	messages := []model.ChatMessage{
		{SessionID: ownedSession.ID, ClientRequestID: &clientRequestID, Role: "user", Content: "如何退货？", CreatedAt: base},
		{SessionID: ownedSession.ID, ClientRequestID: &clientRequestID, Role: "assistant", Content: "请在三十天内申请。", Citations: datatypes.JSON(citations), RerankFallback: datatypes.JSON(fallback), FeedbackRating: &negative, FeedbackUpdatedAt: &feedbackAt, CreatedAt: base.Add(time.Minute)},
		{SessionID: ownedSession.ID, Role: "user", Content: "需要发票吗？", CreatedAt: base.Add(4 * time.Minute)},
		{SessionID: ownedSession.ID, Role: "assistant", Content: "当前资料无法确认。", FeedbackRating: &positive, FeedbackUpdatedAt: &feedbackAt, CreatedAt: base.Add(5 * time.Minute)},
		{SessionID: ownedSession.ID, Role: "assistant", Content: "未评价回答", CreatedAt: base.Add(6 * time.Minute)},
		{SessionID: otherSession.ID, Role: "assistant", Content: "不应泄露", FeedbackRating: &negative, FeedbackUpdatedAt: &feedbackAt, CreatedAt: base.Add(7 * time.Minute)},
	}
	if err := services.db.Create(&messages).Error; err != nil {
		t.Fatalf("create quality messages: %v", err)
	}

	overview, err := services.chats.GetQualityOverview(ctx, owner.ID, dto.ChatQualityOverviewQuery{Period: "month"})
	if err != nil {
		t.Fatalf("quality overview: %v", err)
	}
	if overview.AnswerCount != 3 || overview.FeedbackCount != 2 || overview.PositiveFeedbackCount != 1 ||
		overview.NegativeFeedbackCount != 1 || overview.WithoutCitationsCount != 2 {
		t.Fatalf("unexpected overview counts: %#v", overview)
	}
	if overview.FeedbackCoverage != float64(2)/3 || overview.PositiveRate != 0.5 {
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

func TestGlobalSearchExportContainsAllOwnedMatchesOnly(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "search-export-owner")
	other := createWorkspaceUser(t, services.db, "search-export-other")
	ownerKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "policy owner", "private", time.Now())
	ownerDocument := createWorkspaceDocument(t, services.db, ownerKB.ID, owner.ID, "policy-owner.pdf", "completed")
	createWorkspaceDocumentChunk(t, services.db, ownerKB.ID, ownerDocument.ID, 0, "policy owner content")
	otherKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "policy secret", "private", time.Now())
	otherDocument := createWorkspaceDocument(t, services.db, otherKB.ID, other.ID, "policy-secret.pdf", "completed")
	createWorkspaceDocumentChunk(t, services.db, otherKB.ID, otherDocument.ID, 0, "policy secret content")

	exported, err := services.search.Export(ctx, owner.ID, dto.GlobalSearchRequest{Query: "policy", Type: "all"})
	if err != nil {
		t.Fatalf("export search: %v", err)
	}
	rows := readSearchExportCSV(t, exported)
	if len(rows) != 4 {
		t.Fatalf("expected header and all three owner result types, got %#v", rows)
	}
	content := string(exported.Content)
	if !strings.Contains(content, "policy owner") || !strings.Contains(content, "policy-owner.pdf") || !strings.Contains(content, "policy owner content") {
		t.Fatalf("missing owner results:\n%s", content)
	}
	if strings.Contains(content, "policy secret") {
		t.Fatalf("export leaked another owner's data:\n%s", content)
	}
}

func TestGlobalSearchExportAllows5000ItemsAndRejects5001(t *testing.T) {
	services := newWorkspaceTestServices(t)
	sqlDB, err := services.db.DB()
	if err != nil {
		t.Fatalf("get sqlite pool: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)

	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "search-export-boundary-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "export limit kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "limit.pdf", "completed")
	createWorkspaceDocumentChunksInBatches(t, services.db, kb.ID, document.ID, 0, 5000, "boundary-needle")

	exported, err := services.search.Export(ctx, owner.ID, dto.GlobalSearchRequest{Query: "boundary-needle", Type: "chunk"})
	if err != nil {
		t.Fatalf("export 5000 search results: %v", err)
	}
	rows := readSearchExportCSV(t, exported)
	if len(rows) != 5001 {
		t.Fatalf("expected header plus 5000 rows, got %d", len(rows))
	}

	createWorkspaceDocumentChunksInBatches(t, services.db, kb.ID, document.ID, 5000, 1, "boundary-needle")
	_, err = services.search.Export(ctx, owner.ID, dto.GlobalSearchRequest{Query: "boundary-needle", Type: "chunk"})
	assertAppErrorCode(t, err, "EXPORT_TOO_LARGE")
}

func TestProfileAvatarLimitCountsUnicodeCodePoints(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	user := createWorkspaceUser(t, services.db, "unicode-avatar")
	prefix := "https://example.com/"
	valid := prefix + strings.Repeat("名", MaxAvatarURLLength-utf8.RuneCountInString(prefix))
	if _, err := services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{
		DisplayName: "显示名称",
		AvatarURL:   valid,
	}); err != nil {
		t.Fatalf("expected %d-rune avatar URL to pass: %v", MaxAvatarURLLength, err)
	}

	tooLong := valid + "名"
	_, err := services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{
		DisplayName: "显示名称",
		AvatarURL:   tooLong,
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

func readSearchExportCSV(t *testing.T, exported *ExportFile) [][]string {
	t.Helper()
	if exported.ContentType != "text/csv; charset=utf-8" || exported.Filename != "search-results.csv" {
		t.Fatalf("unexpected export metadata: %#v", exported)
	}
	bom := []byte{0xEF, 0xBB, 0xBF}
	if !bytes.HasPrefix(exported.Content, bom) {
		t.Fatalf("expected UTF-8 BOM, got prefix % x", exported.Content[:min(len(exported.Content), len(bom))])
	}
	content := exported.Content[len(bom):]
	rows, err := csv.NewReader(bytes.NewReader(content)).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v\n%s", err, content)
	}
	wantHeader := []string{"类型", "知识库", "标题", "摘要", "知识库ID", "文档ID", "结果ID"}
	if len(rows) == 0 || !slices.Equal(rows[0], wantHeader) {
		t.Fatalf("unexpected csv header: %#v", rows)
	}
	return rows
}

func createWorkspaceDocumentChunksInBatches(
	t *testing.T,
	db *gorm.DB,
	kbID, documentID uuid.UUID,
	startIndex, count int,
	content string,
) {
	t.Helper()
	chunks := make([]model.DocumentChunk, count)
	for i := range chunks {
		chunks[i] = model.DocumentChunk{
			DocumentID:      documentID,
			KnowledgeBaseID: kbID,
			ChunkIndex:      startIndex + i,
			Content:         content,
		}
	}
	if err := db.CreateInBatches(&chunks, 50).Error; err != nil {
		t.Fatalf("create document chunks in batches: %v", err)
	}
}

func intPointer(value int) *int {
	return &value
}
