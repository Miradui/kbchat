package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
)

// Answers written in the same request can share a created_at, so the sort key
// alone is not a total order. Without the id tiebreaker two adjacent pages could
// return the same row or skip one.
func TestListKnowledgeGapsPaginationIsStableOnTiedTimestamps(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "paging-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "退货政策")
	tied := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)

	for i := 0; i < 4; i++ {
		createGapAnswer(t, services.db, gapAnswer{
			session:        session,
			question:       "问题",
			answer:         "当前资料无法确认。",
			intent:         chatIntentKnowledgeBase,
			retrievalQuery: "跨境退货",
			createdAt:      tied,
		})
	}

	seen := map[string]bool{}
	for page := 1; page <= 2; page++ {
		result, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
			Period:   "month",
			Category: repository.ChatKnowledgeGapNoCitations,
			Page:     page,
			PageSize: 2,
		})
		if err != nil {
			t.Fatalf("list page %d: %v", page, err)
		}
		if result.Total != 4 {
			t.Fatalf("expected 4 gaps in total, got %#v", result)
		}
		if len(result.Items) != 2 {
			t.Fatalf("expected a full page %d, got %d items", page, len(result.Items))
		}
		for _, item := range result.Items {
			if item.MessageID == nil {
				t.Fatalf("expected a message id on a no_citations gap, got %#v", item)
			}
			if seen[*item.MessageID] {
				t.Fatalf("page %d repeated message %s", page, *item.MessageID)
			}
			seen[*item.MessageID] = true
		}
	}
	if len(seen) != 4 {
		t.Fatalf("expected two pages to cover every gap exactly once, saw %d", len(seen))
	}
}

// The "all" category is the two lists concatenated, so the interesting page is the
// one straddling the boundary: it must finish the first category and start the
// second without dropping or duplicating anything.
func TestListKnowledgeGapsCombinedPagingCrossesCategoryBoundary(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "combined-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "退货政策")
	base := time.Now().UTC().Add(-2 * time.Hour)

	// Three ungrounded answers, each a distinct question so none of them cluster.
	for i, query := range []string{"跨境退货", "退货运费", "退货时效"} {
		createGapAnswer(t, services.db, gapAnswer{
			session:        session,
			question:       query + "？",
			answer:         "当前资料无法确认。",
			intent:         chatIntentKnowledgeBase,
			retrievalQuery: query,
			createdAt:      base.Add(time.Duration(i) * time.Minute),
		})
	}
	// Two clusters, each from two rephrasings that all cited something so they do
	// not also show up under no_citations.
	for i, query := range []string{"发票要求", "换货流程"} {
		for attempt := 0; attempt < 2; attempt++ {
			createGapAnswer(t, services.db, gapAnswer{
				session:        session,
				question:       query + "？",
				answer:         "见文档。",
				intent:         chatIntentKnowledgeBase,
				retrievalQuery: query,
				withCitations:  true,
				createdAt:      base.Add(time.Duration(10+i*2+attempt) * time.Minute),
			})
		}
	}

	first, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period:   "month",
		Page:     1,
		PageSize: 2,
	})
	if err != nil {
		t.Fatalf("list first page: %v", err)
	}
	if first.Total != 5 || first.NoCitationsTotal != 3 || first.RepeatedRewriteTotal != 2 {
		t.Fatalf("unexpected totals: %#v", first)
	}
	// Per-category totals are reported even under "all" so a client can label the
	// filter without a second round trip.
	if len(first.Items) != 2 {
		t.Fatalf("expected a full first page, got %#v", first.Items)
	}

	boundary, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period:   "month",
		Page:     2,
		PageSize: 2,
	})
	if err != nil {
		t.Fatalf("list boundary page: %v", err)
	}
	if len(boundary.Items) != 2 {
		t.Fatalf("expected a full boundary page, got %#v", boundary.Items)
	}
	if boundary.Items[0].Category != repository.ChatKnowledgeGapNoCitations {
		t.Fatalf("expected the boundary page to finish no_citations first, got %#v", boundary.Items[0])
	}
	if boundary.Items[1].Category != repository.ChatKnowledgeGapRepeatedRewrite {
		t.Fatalf("expected the boundary page to continue into clusters, got %#v", boundary.Items[1])
	}

	last, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period:   "month",
		Page:     3,
		PageSize: 2,
	})
	if err != nil {
		t.Fatalf("list last page: %v", err)
	}
	if len(last.Items) != 1 || last.Items[0].Category != repository.ChatKnowledgeGapRepeatedRewrite {
		t.Fatalf("expected one trailing cluster, got %#v", last.Items)
	}

	all := append(append([]dto.ChatKnowledgeGapItemResponse{}, first.Items...), boundary.Items...)
	all = append(all, last.Items...)
	if len(all) != 5 {
		t.Fatalf("expected three pages to cover 5 rows, got %d", len(all))
	}
	keys := map[string]bool{}
	for _, item := range all {
		key := item.Category + "|" + item.SessionID + "|" + item.RetrievalQuery
		if item.MessageID != nil {
			key = item.Category + "|" + *item.MessageID
		}
		if keys[key] {
			t.Fatalf("combined paging returned %s twice", key)
		}
		keys[key] = true
	}
}

func TestListKnowledgeGapsClampsPageSize(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "clamp-owner")

	page, err := services.chats.ListKnowledgeGaps(ctx, owner.ID, dto.ChatKnowledgeGapQuery{
		Period:   "month",
		Page:     0,
		PageSize: 5000,
	})
	if err != nil {
		t.Fatalf("list knowledge gaps: %v", err)
	}
	if page.Page != 1 || page.PageSize != 100 {
		t.Fatalf("expected page and size to be clamped, got %#v", page)
	}
	if page.Items == nil {
		t.Fatal("expected an empty slice rather than null items")
	}
}

// Metrics scoped by intent must not silently treat pre-migration answers as
// grounded: they are excluded from the rate and surfaced separately instead.
func TestQualityOverviewReportsUnclassifiedAnswersSeparately(t *testing.T) {
	services := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, services.db, "unclassified-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "产品知识库", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "退货政策")
	base := time.Now().UTC().Add(-time.Hour)

	createGapAnswer(t, services.db, gapAnswer{
		session:        session,
		question:       "支持跨境退货吗？",
		answer:         "当前资料无法确认。",
		intent:         chatIntentKnowledgeBase,
		retrievalQuery: "跨境退货",
		createdAt:      base,
	})
	createGapAnswer(t, services.db, gapAnswer{
		session:        session,
		question:       "如何退货？",
		answer:         "三十天内可退货。",
		intent:         chatIntentKnowledgeBase,
		retrievalQuery: "如何退货",
		withCitations:  true,
		createdAt:      base.Add(time.Minute),
	})
	for i := 0; i < 2; i++ {
		createGapAnswer(t, services.db, gapAnswer{
			session:   session,
			question:  "历史问题",
			answer:    "历史回答",
			createdAt: base.Add(time.Duration(2+i) * time.Minute),
		})
	}

	overview, err := services.chats.GetQualityOverview(ctx, owner.ID, dto.ChatQualityOverviewQuery{Period: "month"})
	if err != nil {
		t.Fatalf("quality overview: %v", err)
	}
	if overview.AnswerCount != 4 || overview.KnowledgeAnswerCount != 2 || overview.UnclassifiedAnswerCount != 2 {
		t.Fatalf("unexpected answer breakdown: %#v", overview)
	}
	if overview.WithoutCitationsCount != 1 {
		t.Fatalf("expected only the classified ungrounded answer to count, got %#v", overview)
	}
	// The rate is over knowledge answers, not over every answer, so 1/2 rather
	// than 1/4 or 3/4.
	if overview.WithoutCitationsRate != 0.5 {
		t.Fatalf("expected the rate to use knowledge answers as denominator, got %#v", overview)
	}
}
