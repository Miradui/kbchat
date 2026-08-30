package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

// Global search spans knowledge bases, so it has no single resource to authorize.
// Its scope has to match what the per-resource endpoints allow, or the palette
// becomes a way to read titles and chunk text the caller would be refused on.
func TestGlobalSearchIncludesSharedKnowledgeBasesAndExcludesOthers(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	document := createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, "policy-guide.md", "completed")
	createWorkspaceDocumentChunk(t, f.services.db, f.kbID, document.ID, 0, "policy chunk content")
	// The fixture base is "docs-kb", which the query does not match, so the
	// knowledge-base arm of the union would never be exercised. Rename it: all three
	// arms have their own predicate and their own arguments, and an arm nothing
	// matches is an arm no test covers.
	if err := f.services.db.Model(&model.KnowledgeBase{}).
		Where("id = ?", f.kbID).
		Update("name", "policy docs-kb").Error; err != nil {
		t.Fatalf("rename knowledge base: %v", err)
	}

	// A second knowledge base nobody in the fixture is a member of.
	other := createWorkspaceUser(t, f.services.db, "policy-outsider")
	otherKB := createWorkspaceKB(t, f.services.db, other.ID, uuid.Nil, "policy elsewhere", "private", time.Now())
	otherDocument := createWorkspaceDocument(t, f.services.db, otherKB.ID, other.ID, "policy-elsewhere.md", "completed")
	createWorkspaceDocumentChunk(t, f.services.db, otherKB.ID, otherDocument.ID, 0, "policy chunk elsewhere")

	request := dto.GlobalSearchRequest{Query: "policy", Type: "all", Page: 1, PageSize: 50}

	// The viewer sees all three row types from the shared base: the base itself
	// (kb.read), the document (document.read) and the chunk (kb.search).
	viewerResults, err := f.services.search.Search(ctx, f.viewer, request)
	if err != nil {
		t.Fatalf("viewer search: %v", err)
	}
	viewerKBs := map[string]int{}
	for _, item := range viewerResults.Items {
		viewerKBs[item.KnowledgeBaseID]++
	}
	if viewerKBs[f.kbID.String()] != 3 {
		t.Fatalf("expected the viewer to match the base, the document and the chunk, got %#v", viewerResults.Items)
	}
	viewerTypes := map[string]bool{}
	for _, item := range viewerResults.Items {
		viewerTypes[item.Type] = true
	}
	if !viewerTypes["knowledgeBase"] || !viewerTypes["document"] || !viewerTypes["chunk"] {
		t.Fatalf("expected every union arm to be exercised, got %#v", viewerResults.Items)
	}
	if viewerKBs[otherKB.ID.String()] != 0 {
		t.Fatalf("the viewer must not see a knowledge base they have no standing in, got %#v", viewerResults.Items)
	}

	strangerResults, err := f.services.search.Search(ctx, f.stranger, request)
	if err != nil {
		t.Fatalf("stranger search: %v", err)
	}
	if len(strangerResults.Items) != 0 || strangerResults.Total != 0 {
		t.Fatalf("expected a non-member to match nothing, got %#v", strangerResults)
	}
}

// Suggest is the command palette, which reads the same two row types on a
// different query. It is asserted separately because it is a separate statement
// with its own argument order, and an argument spliced in the wrong position
// there would silently scope the results to the wrong user.
func TestSearchSuggestFollowsTheSameReachabilityAsSearch(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, "policy-guide.md", "completed")
	if err := f.services.db.Model(&model.KnowledgeBase{}).
		Where("id = ?", f.kbID).
		Update("name", "policy docs-kb").Error; err != nil {
		t.Fatalf("rename knowledge base: %v", err)
	}

	other := createWorkspaceUser(t, f.services.db, "suggest-outsider")
	otherKB := createWorkspaceKB(t, f.services.db, other.ID, uuid.Nil, "policy elsewhere", "private", time.Now())
	createWorkspaceDocument(t, f.services.db, otherKB.ID, other.ID, "policy-elsewhere.md", "completed")

	request := dto.SearchSuggestRequest{Query: "policy", Limit: 10}

	viewerSuggestions, err := f.services.search.Suggest(ctx, f.viewer, request)
	if err != nil {
		t.Fatalf("viewer suggest: %v", err)
	}
	if len(viewerSuggestions.Items) != 2 {
		t.Fatalf("expected the shared base and its document, got %#v", viewerSuggestions.Items)
	}
	for _, item := range viewerSuggestions.Items {
		if item.KnowledgeBaseID != f.kbID.String() {
			t.Fatalf("expected only the shared base, got %#v", viewerSuggestions.Items)
		}
	}

	strangerSuggestions, err := f.services.search.Suggest(ctx, f.stranger, request)
	if err != nil {
		t.Fatalf("stranger suggest: %v", err)
	}
	if len(strangerSuggestions.Items) != 0 {
		t.Fatalf("expected a non-member to be suggested nothing, got %#v", strangerSuggestions.Items)
	}
}

// The point of widening the quality scope: a manager is looking at what other
// people asked. Under the previous owner-only scope this test would see zero
// answers, because the questions belong to a colleague.
func TestQualityOverviewCountsColleaguesQuestions(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	createQualityAnswer(t, f.services.db, f.kbID, f.viewer, "退货政策是什么")

	overview, err := f.services.chats.GetQualityOverview(ctx, f.manager, dto.ChatQualityOverviewQuery{
		Period:          "month",
		KnowledgeBaseID: &f.kbID,
	})
	if err != nil {
		t.Fatalf("manager quality overview: %v", err)
	}
	if overview.AnswerCount != 1 {
		t.Fatalf("expected the manager to count the viewer's answer, got %#v", overview)
	}

	// The owner sees it too, which is the case that previously worked only because
	// the owner happened to be the one asking.
	ownerOverview, err := f.services.chats.GetQualityOverview(ctx, f.owner, dto.ChatQualityOverviewQuery{
		Period:          "month",
		KnowledgeBaseID: &f.kbID,
	})
	if err != nil {
		t.Fatalf("owner quality overview: %v", err)
	}
	if ownerOverview.AnswerCount != 1 {
		t.Fatalf("expected the owner to count the viewer's answer, got %#v", ownerOverview)
	}
}

// Widening the scope must not widen it past the capability. An unfiltered request
// is the dangerous one: with no knowledge base id there is no single resource for
// the service to authorize, so the query itself has to do the excluding.
func TestUnfilteredQualityReadsExcludeBasesTheActorCannotOperate(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	createQualityAnswer(t, f.services.db, f.kbID, f.viewer, "共享库的问题")

	// A base the fixture manager owns, so their unfiltered view is not empty for
	// the wrong reason, plus a base they have no standing in at all.
	managedKB := createWorkspaceKB(t, f.services.db, f.manager, uuid.Nil, "managed-kb", "private", time.Now())
	createQualityAnswer(t, f.services.db, managedKB.ID, f.manager, "自己库的问题")
	outsider := createWorkspaceUser(t, f.services.db, "quality-outsider")
	outsiderKB := createWorkspaceKB(t, f.services.db, outsider.ID, uuid.Nil, "outsider-kb", "private", time.Now())
	createQualityAnswer(t, f.services.db, outsiderKB.ID, outsider.ID, "别人库的问题")

	overview, err := f.services.chats.GetQualityOverview(ctx, f.manager, dto.ChatQualityOverviewQuery{Period: "7d"})
	if err != nil {
		t.Fatalf("unfiltered quality overview: %v", err)
	}
	// Two: the shared base they manage and the base they own. Not the outsider's.
	if overview.AnswerCount != 2 {
		t.Fatalf("expected the manager to see only reachable bases, got %#v", overview)
	}

	// An editor holds no quality.read anywhere, so an unfiltered request is empty
	// rather than forbidden: there is no single resource to refuse them on.
	editorOverview, err := f.services.chats.GetQualityOverview(ctx, f.editor, dto.ChatQualityOverviewQuery{Period: "7d"})
	if err != nil {
		t.Fatalf("editor unfiltered quality overview: %v", err)
	}
	if editorOverview.AnswerCount != 0 {
		t.Fatalf("expected an editor to see no quality data at all, got %#v", editorOverview)
	}
}

// The gap and feedback lists build on the same scope through four derived
// predicates. Each one is its own SQL statement, so each is asserted.
func TestKnowledgeGapAndFeedbackListsUseTheWidenedScope(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	message := createQualityAnswer(t, f.services.db, f.kbID, f.viewer, "没有引用的问题")
	if err := f.services.db.Model(&model.ChatMessage{}).
		Where("id = ?", message).
		Updates(map[string]any{"feedback_rating": "negative", "feedback_updated_at": time.Now().UTC().Add(-time.Second)}).Error; err != nil {
		t.Fatalf("mark negative feedback: %v", err)
	}

	gaps, err := f.services.chats.ListKnowledgeGaps(ctx, f.manager, dto.ChatKnowledgeGapQuery{
		Period:          "month",
		KnowledgeBaseID: &f.kbID,
		Category:        repository.ChatKnowledgeGapNoCitations,
	})
	if err != nil {
		t.Fatalf("manager knowledge gaps: %v", err)
	}
	if gaps.Total != 1 || len(gaps.Items) != 1 {
		t.Fatalf("expected the colleague's ungrounded answer in the gap list, got %#v", gaps)
	}

	feedback, err := f.services.chats.ListNegativeFeedback(ctx, f.manager, dto.ChatQualityFeedbackQuery{
		Period:          "month",
		KnowledgeBaseID: &f.kbID,
	})
	if err != nil {
		t.Fatalf("manager negative feedback: %v", err)
	}
	if feedback.Total != 1 || len(feedback.Items) != 1 {
		t.Fatalf("expected the colleague's negative rating in the feedback list, got %#v", feedback)
	}
}

// Retrieval is the endpoint behind the search panel. It answers with chunk text,
// so it is scoped by kb.search rather than by ownership.
func TestRetrievalSearchIsScopedByCapability(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)

	// A viewer passes the check. Retrieval then fails on the embedding provider,
	// which the test services do not configure — reaching that failure is what
	// proves authorization allowed the call through.
	_, viewerErr := f.services.retrieval.Search(ctx, f.viewer, f.kbID, dto.SearchRequest{Query: "退货"})
	if viewerErr == nil {
		t.Fatalf("expected the stub embedder to fail after the check passed")
	}
	assertNotAppError(t, viewerErr, "KNOWLEDGE_BASE_NOT_FOUND")
	assertNotAppError(t, viewerErr, "FORBIDDEN")

	// A non-member gets 404, not 403: a 403 would confirm the id exists.
	_, strangerErr := f.services.retrieval.Search(ctx, f.stranger, f.kbID, dto.SearchRequest{Query: "退货"})
	assertAppError(t, strangerErr, "KNOWLEDGE_BASE_NOT_FOUND")
}

// createQualityAnswer writes the user question and the assistant answer that the
// quality queries pair up, and returns the assistant message id.
//
// Rows are written directly rather than through ChatService.Send, because Send
// needs a chat provider and an embedder; what these tests need is only that the
// scope finds an answer belonging to someone other than the actor.
func createQualityAnswer(t *testing.T, db *gorm.DB, kbID, askerID uuid.UUID, question string) uuid.UUID {
	t.Helper()
	session := model.ChatSession{
		UserID:          askerID,
		KnowledgeBaseID: kbID,
		Title:           question,
	}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create chat session: %v", err)
	}
	requestID := uuid.New()
	// Just in the past: endAt is time.Now(), so an answer stamped "now" can land
	// after the upper bound and be excluded. Seconds rather than minutes because the
	// period starts at the beginning of the month, and a wider offset would put the
	// fixture outside the window for a test run early on the first of the month.
	asked := time.Now().UTC().Add(-2 * time.Second)
	messages := []model.ChatMessage{
		{
			SessionID:       session.ID,
			Role:            "user",
			Content:         question,
			ClientRequestID: &requestID,
			CreatedAt:       asked,
		},
		{
			SessionID:       session.ID,
			Role:            "assistant",
			Content:         "答案",
			Intent:          strPtr("knowledge_base"),
			ClientRequestID: &requestID,
			CreatedAt:       asked.Add(time.Second),
		},
	}
	for i := range messages {
		if err := db.Create(&messages[i]).Error; err != nil {
			t.Fatalf("create chat message: %v", err)
		}
	}
	return messages[1].ID
}

// assertNotAppError fails when err carries the given code. Used where the point is
// that a check was passed rather than which later failure occurred.
func assertNotAppError(t *testing.T, err error, code string) {
	t.Helper()
	var appErr *apperror.Error
	if errors.As(err, &appErr) && appErr.Code == code {
		t.Fatalf("did not expect %s, got %v", code, err)
	}
}

func strPtr(value string) *string {
	return &value
}
