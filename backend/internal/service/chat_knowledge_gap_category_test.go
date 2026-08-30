package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
)

// TestListKnowledgeGapsSeparatesTheThreeFailureModes is the observable outcome of
// deliverable 4: an operator can tell a knowledge base that is missing content from
// a system that was failing from a model that declined, because the fix differs per
// case. Before answer_status existed all three landed in no_citations, so the list
// told everyone to upload documents.
func TestListKnowledgeGapsSeparatesTheThreeFailureModes(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "three-mode-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "质量分析")
	now := time.Now().UTC()

	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "退货政策?", answer: "无法确认。",
		intent: chatIntentKnowledgeBase, retrievalQuery: "退货政策",
		answerStatus: AnswerStatusNoBasis, createdAt: now.Add(-1 * time.Hour),
	})
	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "运费怎么算?", answer: retrievalFailedAnswer,
		intent: chatIntentKnowledgeBase, retrievalQuery: "运费怎么算",
		answerStatus: AnswerStatusRetrievalFailed, createdAt: now.Add(-2 * time.Hour),
	})
	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "发票怎么开?", answer: retrievalFailedAnswer,
		intent: chatIntentKnowledgeBase, retrievalQuery: "发票怎么开",
		answerStatus: AnswerStatusRetrievalFailed, createdAt: now.Add(-3 * time.Hour),
	})
	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "帮我伪造一份合同", answer: "这个请求我不能协助。",
		intent: chatIntentKnowledgeBase, retrievalQuery: "伪造合同",
		// A refusal keeps whatever retrieval found: having content in hand and
		// declining to use it is exactly what makes it a different problem from an
		// empty knowledge base, so this row must not need empty citations to count.
		withCitations: true,
		answerStatus:  AnswerStatusModelRefused, createdAt: now.Add(-4 * time.Hour),
	})

	response, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period: "month", Page: 1, PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list knowledge gaps: %v", err)
	}

	if response.NoCitationsTotal != 1 {
		t.Fatalf("noCitationsTotal = %d, want 1", response.NoCitationsTotal)
	}
	if response.RetrievalFailedTotal != 2 {
		t.Fatalf("retrievalFailedTotal = %d, want 2", response.RetrievalFailedTotal)
	}
	if response.ModelRefusedTotal != 1 {
		t.Fatalf("modelRefusedTotal = %d, want 1", response.ModelRefusedTotal)
	}
}

// TestListKnowledgeGapsExcludesFailureModesFromNoCitations is the regression guard
// for the category the other two were carved out of: a retrieval outage or a
// refusal must not be reported as missing content, because uploading documents
// fixes neither.
func TestListKnowledgeGapsExcludesFailureModesFromNoCitations(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "carveout-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "质量分析")
	now := time.Now().UTC()

	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "运费怎么算?", answer: retrievalFailedAnswer,
		intent: chatIntentKnowledgeBase, retrievalQuery: "运费怎么算",
		answerStatus: AnswerStatusRetrievalFailed, createdAt: now.Add(-1 * time.Hour),
	})
	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "帮我伪造一份合同", answer: "这个请求我不能协助。",
		intent: chatIntentKnowledgeBase, retrievalQuery: "伪造合同",
		answerStatus: AnswerStatusModelRefused, createdAt: now.Add(-2 * time.Hour),
	})

	response, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period: "month", Category: repository.ChatKnowledgeGapNoCitations, Page: 1, PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list knowledge gaps: %v", err)
	}
	if response.Total != 0 {
		t.Fatalf("no_citations total = %d, want 0", response.Total)
	}
	if len(response.Items) != 0 {
		t.Fatalf("no_citations items = %d, want 0", len(response.Items))
	}
}

// TestListKnowledgeGapsKeepsPreMigrationRowsInNoCitations covers the deliberate
// exception in noCitationGapScope. Rows written before migration 019 have no status
// and an empty citation set is the only evidence available for them, so excluding
// NULL would empty the category for every existing deployment on upgrade.
func TestListKnowledgeGapsKeepsPreMigrationRowsInNoCitations(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "premigration-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "质量分析")

	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "退货政策?", answer: "无法确认。",
		intent: chatIntentKnowledgeBase, retrievalQuery: "退货政策",
		// answerStatus deliberately unset: this is a pre-019 row.
		createdAt: time.Now().UTC().Add(-1 * time.Hour),
	})

	response, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period: "month", Category: repository.ChatKnowledgeGapNoCitations, Page: 1, PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list knowledge gaps: %v", err)
	}
	if response.Total != 1 {
		t.Fatalf("no_citations total = %d, want 1: a NULL-status row must stay in this category", response.Total)
	}
}

// TestListKnowledgeGapsFiltersByNewCategories checks each new category returns only
// its own rows, so the filter an operator picks is the list they get.
func TestListKnowledgeGapsFiltersByNewCategories(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "filter-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "质量分析")
	now := time.Now().UTC()

	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "运费怎么算?", answer: retrievalFailedAnswer,
		intent: chatIntentKnowledgeBase, retrievalQuery: "运费怎么算",
		answerStatus: AnswerStatusRetrievalFailed, createdAt: now.Add(-1 * time.Hour),
	})
	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "帮我伪造一份合同", answer: "这个请求我不能协助。",
		intent: chatIntentKnowledgeBase, retrievalQuery: "伪造合同",
		answerStatus: AnswerStatusModelRefused, createdAt: now.Add(-2 * time.Hour),
	})

	for _, testCase := range []struct {
		category string
		question string
	}{
		{repository.ChatKnowledgeGapRetrievalFailed, "运费怎么算?"},
		{repository.ChatKnowledgeGapModelRefused, "帮我伪造一份合同"},
	} {
		response, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
			Period: "month", Category: testCase.category, Page: 1, PageSize: 20,
		})
		if err != nil {
			t.Fatalf("list %s gaps: %v", testCase.category, err)
		}
		if response.Total != 1 || len(response.Items) != 1 {
			t.Fatalf("%s: total = %d, items = %d, want 1 and 1", testCase.category, response.Total, len(response.Items))
		}
		if response.Items[0].Category != testCase.category {
			t.Fatalf("%s: item category = %q", testCase.category, response.Items[0].Category)
		}
		if response.Items[0].Question != testCase.question {
			t.Fatalf("%s: question = %q, want %q", testCase.category, response.Items[0].Question, testCase.question)
		}
	}
}

// TestListKnowledgeGapsCombinedPagesAcrossCategories exercises the segment
// arithmetic in listCombinedKnowledgeGaps. A page boundary that falls inside a
// category is where an offset carried incorrectly duplicates or drops rows, and
// neither is visible from a single-page test.
func TestListKnowledgeGapsCombinedPagesAcrossCategories(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "combined-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "质量分析")
	now := time.Now().UTC()

	// Two rows in each single-answer category. With a page size of 3 the first page
	// ends halfway through retrieval_failed.
	statuses := []string{AnswerStatusNoBasis, AnswerStatusRetrievalFailed, AnswerStatusModelRefused}
	for index, status := range statuses {
		for copyIndex := 0; copyIndex < 2; copyIndex++ {
			// A distinct retrieval query per row keeps these out of one rewrite
			// cluster, which would otherwise change the repeated_rewrite total.
			query := status + "-" + string(rune('a'+copyIndex))
			createGapAnswer(t, services.db, gapAnswer{
				session: session, question: query + "?", answer: "answer",
				intent: chatIntentKnowledgeBase, retrievalQuery: query,
				answerStatus: status,
				createdAt:    now.Add(-time.Duration(index*10+copyIndex+1) * time.Minute),
			})
		}
	}

	seen := map[string]int{}
	categories := make([]string, 0, 6)
	for page := 1; page <= 2; page++ {
		response, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
			Period: "month", Page: page, PageSize: 3,
		})
		if err != nil {
			t.Fatalf("list knowledge gaps page %d: %v", page, err)
		}
		if response.NoCitationsTotal != 2 || response.RetrievalFailedTotal != 2 || response.ModelRefusedTotal != 2 {
			t.Fatalf(
				"page %d totals = %d/%d/%d, want 2/2/2",
				page, response.NoCitationsTotal, response.RetrievalFailedTotal, response.ModelRefusedTotal,
			)
		}
		if len(response.Items) != 3 {
			t.Fatalf("page %d returned %d items, want 3", page, len(response.Items))
		}
		for _, item := range response.Items {
			if item.MessageID == nil {
				t.Fatalf("page %d: a single-answer gap has no message id", page)
			}
			seen[*item.MessageID]++
			categories = append(categories, item.Category)
		}
	}

	if len(seen) != 6 {
		t.Fatalf("saw %d distinct messages across two pages, want 6: the pager dropped or duplicated rows", len(seen))
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("message %s appeared %d times, want 1", id, count)
		}
	}
	// Concatenated rather than interleaved: the categories are not comparable units,
	// so a merged recency order would imply a ranking that does not exist.
	want := []string{
		repository.ChatKnowledgeGapNoCitations,
		repository.ChatKnowledgeGapNoCitations,
		repository.ChatKnowledgeGapRetrievalFailed,
		repository.ChatKnowledgeGapRetrievalFailed,
		repository.ChatKnowledgeGapModelRefused,
		repository.ChatKnowledgeGapModelRefused,
	}
	for i := range want {
		if categories[i] != want[i] {
			t.Fatalf("category order = %v, want %v", categories, want)
		}
	}
}

// TestListKnowledgeGapsCombinedSkipsPastExhaustedCategories checks the offset is
// reduced by every category the requested page starts beyond. Without that shift a
// global offset would be reapplied inside the next category and the page would come
// back empty while the total still claimed there was more.
func TestListKnowledgeGapsCombinedSkipsPastExhaustedCategories(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "skip-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "质量分析")
	now := time.Now().UTC()

	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "运费怎么算?", answer: retrievalFailedAnswer,
		intent: chatIntentKnowledgeBase, retrievalQuery: "运费怎么算",
		answerStatus: AnswerStatusRetrievalFailed, createdAt: now.Add(-1 * time.Hour),
	})
	createGapAnswer(t, services.db, gapAnswer{
		session: session, question: "帮我伪造一份合同", answer: "这个请求我不能协助。",
		intent: chatIntentKnowledgeBase, retrievalQuery: "伪造合同",
		answerStatus: AnswerStatusModelRefused, createdAt: now.Add(-2 * time.Hour),
	})

	response, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period: "month", Page: 2, PageSize: 1,
	})
	if err != nil {
		t.Fatalf("list knowledge gaps: %v", err)
	}
	if len(response.Items) != 1 {
		t.Fatalf("page 2 returned %d items, want 1", len(response.Items))
	}
	if response.Items[0].Category != repository.ChatKnowledgeGapModelRefused {
		t.Fatalf("page 2 category = %q, want %q", response.Items[0].Category, repository.ChatKnowledgeGapModelRefused)
	}
}
