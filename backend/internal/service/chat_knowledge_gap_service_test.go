package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

// gapAnswer describes one assistant row for the knowledge gap fixtures. The
// helper fills in the normalized query so a test cannot accidentally exercise a
// cluster key the service would never have written.
type gapAnswer struct {
	session         model.ChatSession
	question        string
	answer          string
	intent          string
	retrievalQuery  string
	withCitations   bool
	noClientRequest bool
	// answerStatus is left empty to mean NULL, which is what a row written before
	// migration 019 looks like. Tests about the three failure modes must set it.
	answerStatus string
	createdAt    time.Time
}

func createGapAnswer(t *testing.T, db *gorm.DB, spec gapAnswer) model.ChatMessage {
	t.Helper()

	var clientRequestID *uuid.UUID
	if !spec.noClientRequest {
		id := uuid.New()
		clientRequestID = &id
	}
	if spec.question != "" {
		userMessage := model.ChatMessage{
			SessionID:       spec.session.ID,
			ClientRequestID: clientRequestID,
			Role:            "user",
			Content:         spec.question,
			CreatedAt:       spec.createdAt.Add(-time.Second),
		}
		if err := db.Create(&userMessage).Error; err != nil {
			t.Fatalf("create gap question: %v", err)
		}
	}

	answer := model.ChatMessage{
		SessionID:       spec.session.ID,
		ClientRequestID: clientRequestID,
		Role:            "assistant",
		Content:         spec.answer,
		CreatedAt:       spec.createdAt,
	}
	if spec.intent != "" {
		intent := spec.intent
		answer.Intent = &intent
	}
	if spec.retrievalQuery != "" {
		query := spec.retrievalQuery
		answer.RetrievalQuery = &query
		if norm := normalizeRetrievalQuery(query); norm != "" {
			answer.RetrievalQueryNorm = &norm
		}
	}
	if spec.withCitations {
		answer.Citations = datatypes.JSON([]byte(
			`[{"documentId":"` + uuid.NewString() + `","chunkId":"` + uuid.NewString() +
				`","filename":"policy.pdf","content":"三十天内可退货。"}]`,
		))
	}
	if spec.answerStatus != "" {
		status := spec.answerStatus
		answer.AnswerStatus = &status
	}
	if err := db.Create(&answer).Error; err != nil {
		t.Fatalf("create gap answer: %v", err)
	}
	return answer
}

func TestListKnowledgeGapsNoCitationsExcludesConversationAndUnclassified(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "gap-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "退货政策")
	base := time.Now().UTC().Add(-time.Hour)

	gap := createGapAnswer(t, services.db, gapAnswer{
		session:        session,
		question:       "支持跨境退货吗？",
		answer:         "当前资料无法确认。",
		intent:         chatIntentKnowledgeBase,
		retrievalQuery: "跨境退货",
		createdAt:      base,
	})
	// A knowledge answer that did cite something is not a gap.
	createGapAnswer(t, services.db, gapAnswer{
		session:        session,
		question:       "如何退货？",
		answer:         "三十天内可退货。",
		intent:         chatIntentKnowledgeBase,
		retrievalQuery: "如何退货",
		withCitations:  true,
		createdAt:      base.Add(time.Minute),
	})
	// A conversation answer is given empty citations on purpose.
	createGapAnswer(t, services.db, gapAnswer{
		session:   session,
		question:  "你好",
		answer:    "你好，我可以帮你查询知识库。",
		intent:    chatIntentConversation,
		createdAt: base.Add(2 * time.Minute),
	})
	// A pre-migration answer carries no intent, so whether it retrieved anything
	// is unknowable and it must not be reported as a gap.
	createGapAnswer(t, services.db, gapAnswer{
		session:   session,
		question:  "历史问题",
		answer:    "历史回答",
		createdAt: base.Add(3 * time.Minute),
	})

	page, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period:   "month",
		Category: repository.ChatKnowledgeGapNoCitations,
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list knowledge gaps: %v", err)
	}
	if page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("expected exactly one no_citations gap, got %#v", page)
	}
	item := page.Items[0]
	if item.Category != repository.ChatKnowledgeGapNoCitations {
		t.Fatalf("unexpected category: %#v", item)
	}
	if item.MessageID == nil || *item.MessageID != gap.ID.String() {
		t.Fatalf("expected the ungrounded answer id, got %#v", item.MessageID)
	}
	if item.Question != "支持跨境退货吗？" || item.RetrievalQuery != "跨境退货" {
		t.Fatalf("unexpected question or retrieval query: %#v", item)
	}
	if item.SessionTitle != "退货政策" || item.KnowledgeBaseName != "产品知识库" {
		t.Fatalf("expected session and knowledge base labels, got %#v", item)
	}
	// One answer is one occurrence, and it is ungrounded by definition of the category.
	if item.OccurrenceCount != 1 || item.UngroundedCount != 1 {
		t.Fatalf("unexpected counts on a single-answer gap: %#v", item)
	}
}

func TestListKnowledgeGapsRepeatedRewriteClustersAndExcludesRegenerations(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "rewrite-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "退货政策")
	other := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "另一个会话")
	base := time.Now().UTC().Add(-time.Hour)

	// Two rephrasings of one question in one session: a cluster. Spacing differs,
	// which is exactly what normalization is there to collapse.
	createGapAnswer(t, services.db, gapAnswer{
		session:        session,
		question:       "退货政策是什么？",
		answer:         "当前资料无法确认。",
		intent:         chatIntentKnowledgeBase,
		retrievalQuery: "退货政策",
		createdAt:      base,
	})
	createGapAnswer(t, services.db, gapAnswer{
		session:        session,
		question:       "退货 政策到底怎么算？",
		answer:         "三十天内可退货。",
		intent:         chatIntentKnowledgeBase,
		retrievalQuery: "退货 政策",
		withCitations:  true,
		createdAt:      base.Add(2 * time.Minute),
	})
	// Same question asked once in another session: below the threshold there.
	createGapAnswer(t, services.db, gapAnswer{
		session:        other,
		question:       "退货政策是什么？",
		answer:         "三十天内可退货。",
		intent:         chatIntentKnowledgeBase,
		retrievalQuery: "退货政策",
		withCitations:  true,
		createdAt:      base.Add(3 * time.Minute),
	})
	// Two regenerations of one question: the user asked once, so this is not a rewrite.
	for i := 0; i < 2; i++ {
		createGapAnswer(t, services.db, gapAnswer{
			session:         session,
			answer:          "重新生成的回答",
			intent:          chatIntentKnowledgeBase,
			retrievalQuery:  "发票要求",
			noClientRequest: true,
			createdAt:       base.Add(time.Duration(4+i) * time.Minute),
		})
	}

	page, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period:   "month",
		Category: repository.ChatKnowledgeGapRepeatedRewrite,
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list knowledge gaps: %v", err)
	}
	if page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("expected one rewrite cluster, got %#v", page)
	}
	cluster := page.Items[0]
	if cluster.Category != repository.ChatKnowledgeGapRepeatedRewrite {
		t.Fatalf("unexpected category: %#v", cluster)
	}
	// A cluster spans several answers, so it cannot point at one message.
	if cluster.MessageID != nil {
		t.Fatalf("expected a cluster to expose no message id, got %#v", cluster.MessageID)
	}
	if cluster.SessionID != session.ID.String() {
		t.Fatalf("expected the cluster to stay inside one session, got %#v", cluster)
	}
	if cluster.OccurrenceCount != 2 {
		t.Fatalf("expected both rephrasings in the cluster, got %#v", cluster)
	}
	// Only the first of the two retrieved nothing.
	if cluster.UngroundedCount != 1 {
		t.Fatalf("expected one ungrounded answer in the cluster, got %#v", cluster)
	}
	if !cluster.FirstSeenAt.Before(cluster.LastSeenAt) {
		t.Fatalf("expected the cluster window to span both answers, got %#v", cluster)
	}
}

func TestListKnowledgeGapsIsOwnerScoped(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "scope-owner")
	other := createWorkspaceUser(t, services.db, "scope-other")
	ownedKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	otherKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "机密知识库", "private", time.Now())
	deletedKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "已删除知识库", "private", time.Now())
	ownedSession := createWorkspaceChatSession(t, services.db, owner.ID, ownedKB.ID, "退货政策")
	otherSession := createWorkspaceChatSession(t, services.db, other.ID, otherKB.ID, "机密会话")
	deletedKBSession := createWorkspaceChatSession(t, services.db, owner.ID, deletedKB.ID, "已删除知识库会话")
	deletedSession := createWorkspaceChatSession(t, services.db, owner.ID, ownedKB.ID, "已删除会话")
	base := time.Now().UTC().Add(-time.Hour)

	for i, session := range []model.ChatSession{ownedSession, otherSession, deletedKBSession, deletedSession} {
		createGapAnswer(t, services.db, gapAnswer{
			session:        session,
			question:       "支持跨境退货吗？",
			answer:         "当前资料无法确认。",
			intent:         chatIntentKnowledgeBase,
			retrievalQuery: "跨境退货",
			createdAt:      base.Add(time.Duration(i) * time.Minute),
		})
	}
	if err := services.db.Delete(&deletedKB).Error; err != nil {
		t.Fatalf("soft delete knowledge base: %v", err)
	}
	if err := services.db.Delete(&deletedSession).Error; err != nil {
		t.Fatalf("soft delete session: %v", err)
	}

	page, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period:   "month",
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list knowledge gaps: %v", err)
	}
	if page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("expected only the live owned gap, got %#v", page)
	}
	if page.Items[0].SessionID != ownedSession.ID.String() {
		t.Fatalf("unexpected session in owner-scoped result: %#v", page.Items[0])
	}

	// Filtering by someone else's knowledge base must not leak its existence
	// through a different error than a missing one.
	if _, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period:          "month",
		KnowledgeBaseID: &otherKB.ID,
		Page:            1,
		PageSize:        20,
	}); err == nil {
		t.Fatal("expected another owner's knowledge base to be rejected")
	} else {
		assertAppErrorCode(t, err, "KNOWLEDGE_BASE_NOT_FOUND")
	}
}

func TestListKnowledgeGapsRejectsUnknownCategory(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "category-owner")

	_, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period:   "month",
		Category: "everything",
		Page:     1,
		PageSize: 20,
	})
	// Coercing an unknown filter to "all" would show an operator a list that is
	// not the one they asked for.
	assertAppErrorCode(t, err, "VALIDATION_ERROR")
}
