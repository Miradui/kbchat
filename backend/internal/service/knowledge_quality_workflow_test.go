package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"testing"
	"time"
)

type scopedEvaluationRetrieval struct {
	evaluationRetrieval
	mode       string
	bases      []uuid.UUID
	resultBase uuid.UUID
}

func (r *scopedEvaluationRetrieval) search(ctx context.Context, actor uuid.UUID, bases []uuid.UUID, req dto.SearchRequest, mode string) (*dto.SearchResponse, error) {
	r.mode, r.bases = mode, bases
	result, err := r.Search(ctx, actor, bases[0], req)
	if err == nil {
		result.Items[0].KnowledgeBaseID = r.resultBase.String()
	}
	return result, err
}
func (r *scopedEvaluationRetrieval) SearchMany(ctx context.Context, actor uuid.UUID, bases []uuid.UUID, req dto.SearchRequest) (*dto.SearchResponse, error) {
	return r.search(ctx, actor, bases, req, "multi")
}
func (r *scopedEvaluationRetrieval) SearchAutomatic(ctx context.Context, actor uuid.UUID, bases []uuid.UUID, req dto.SearchRequest) (*dto.SearchResponse, error) {
	return r.search(ctx, actor, bases, req, "auto")
}

func TestScopedEvaluationRetainsScopeAndRevokesAllSources(t *testing.T) {
	for _, mode := range []string{"multi", "auto", "documents"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			s, w, actor, kb, _, _ := evaluationFixture(t)
			second := createWorkspaceKB(t, w.db, actor, uuid.Nil, "second", "private", time.Now())
			req := dto.CreateChatSessionRequest{KnowledgeBaseIDs: []string{kb.String(), second.ID.String()}}
			if mode == "auto" {
				req = dto.CreateChatSessionRequest{ScopeMode: "auto"}
			}
			if mode == "documents" {
				doc, err := w.documents.CreateText(ctx, actor, second.ID, dto.TextDocumentRequest{Title: "chosen", Content: "selected facts"})
				if err != nil {
					t.Fatal(err)
				}
				req.DocumentIDs = []string{doc.ID}
			}
			source, err := w.chats.CreateSession(ctx, actor, req)
			if err != nil {
				t.Fatal(err)
			}
			primary := uuid.MustParse(source.KnowledgeBaseID)
			resultBase := second.ID
			if primary == second.ID {
				resultBase = kb
			}
			search := &scopedEvaluationRetrieval{resultBase: resultBase}
			w.chats.retrieval = search
			item, err := s.SaveCase(ctx, actor, primary, uuid.Nil, dto.EvaluationCaseRequest{Question: "退货规则", SourceSessionID: source.ID})
			if err != nil {
				t.Fatal(err)
			}
			run, err := s.CreateRun(ctx, actor, primary, evaluationRequest(item.ID))
			if err != nil {
				t.Fatal(err)
			}
			if !run.IsPrivate || run.Cases[0].Scope == nil {
				t.Fatal("missing private scope")
			}
			if _, err = s.ProcessNext(ctx); err != nil {
				t.Fatal(err)
			}
			done, err := s.GetRun(ctx, actor, primary, uuid.MustParse(run.ID))
			if err != nil {
				t.Fatal(err)
			}
			if len(done.Results) != 1 || done.Results[0].ErrorCode != "" {
				t.Fatalf("result %+v", done.Results)
			}
			expected := "multi"
			if mode == "auto" {
				expected = "auto"
			}
			if search.mode != expected || len(search.bases) != 2 {
				t.Fatalf("scope %s %v", search.mode, search.bases)
			}
			if mode == "documents" && len(search.requests[0].DocumentIDs) != 1 {
				t.Fatal("lost document restriction")
			}
			var count int64
			w.db.Model(&model.ChatSession{}).Count(&count)
			if count != 1 {
				t.Fatal("evaluation created chats")
			}
			other := createWorkspaceUser(t, w.db, "other-manager")
			for _, id := range []uuid.UUID{kb, second.ID} {
				if err = w.db.Create(&model.KnowledgeBaseMember{KnowledgeBaseID: id, UserID: other.ID, Role: "manager"}).Error; err != nil {
					t.Fatal(err)
				}
			}
			visible, err := s.ListCases(ctx, other.ID, primary)
			if err != nil || len(visible) != 0 {
				t.Fatalf("private cases leaked %+v %v", visible, err)
			}
			_, err = s.GetRun(ctx, other.ID, primary, uuid.MustParse(run.ID))
			if err == nil {
				t.Fatal("private run leaked")
			}
			// Revoke a source that is not the primary, including dynamic auto results.
			revoked := second.ID
			if primary == second.ID {
				revoked = kb
			}
			if err = w.db.Model(&model.KnowledgeBase{}).Where("id = ?", revoked).Update("owner_id", other.ID).Error; err != nil {
				t.Fatal(err)
			}
			_, err = s.GetRun(ctx, actor, primary, uuid.MustParse(run.ID))
			if err == nil {
				t.Fatal("revoked source run visible")
			}
		})
	}
}

func TestQualityIssueFollowupResolutionAndScopeValidation(t *testing.T) {
	ctx := context.Background()
	s, w, actor, kb, _, _ := evaluationFixture(t)
	w.chats.SetEvaluations(s)
	source, err := w.chats.CreateSession(ctx, actor, dto.CreateChatSessionRequest{KnowledgeBaseID: kb.String()})
	if err != nil {
		t.Fatal(err)
	}
	sid := uuid.MustParse(source.ID)
	if err = w.db.Create(&model.ChatMessage{SessionID: sid, Role: "user", Content: "退货规则"}).Error; err != nil {
		t.Fatal(err)
	}
	item, err := s.SaveCase(ctx, actor, kb, uuid.Nil, dto.EvaluationCaseRequest{Question: "退货规则", SourceSessionID: source.ID})
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.CreateRun(ctx, actor, kb, evaluationRequest(item.ID))
	if err != nil {
		t.Fatal(err)
	}
	req := dto.ChatQualityIssueRequest{Question: "退货规则", Status: "retest", Note: "已补充说明", EvaluationCaseID: item.ID, EvaluationRunID: run.ID}
	for _, status := range []string{"retest", "resolved", "open"} {
		req.Status = status
		saved, err := w.chats.SaveQualityIssue(ctx, actor, sid, req)
		if err != nil || saved.Status != status || saved.EvaluationRunID != run.ID {
			t.Fatalf("saved %+v %v", saved, err)
		}
	}
	var count int64
	w.db.Model(&model.ChatQualityIssue{}).Count(&count)
	if count != 1 {
		t.Fatal("duplicate followup")
	}
	req.Question = "不是来源问题"
	_, err = w.chats.SaveQualityIssue(ctx, actor, sid, req)
	if err == nil {
		t.Fatal("unrelated question accepted")
	}
	other := createWorkspaceUser(t, w.db, "issue-stranger")
	_, err = w.chats.GetQualityIssue(ctx, other.ID, sid, "退货规则")
	if err == nil {
		t.Fatal("other account read issue")
	}
	shared := saveEvaluationCase(t, s, actor, kb, "shared", nil, false)
	_, err = s.SaveCase(ctx, actor, kb, uuid.MustParse(shared.ID), dto.EvaluationCaseRequest{Question: "shared", SourceSessionID: source.ID})
	if err == nil {
		t.Fatal("shared case became private")
	}
	if err = s.DeleteCase(ctx, actor, kb, uuid.MustParse(item.ID)); err != nil {
		t.Fatal(err)
	}
	issue, err := w.chats.GetQualityIssue(ctx, actor, sid, "退货规则")
	if err != nil || issue.EvaluationCaseID != "" {
		t.Fatalf("deleted case reference %+v %v", issue, err)
	}
}

func TestPersonalQualityCountAndListUseSameAuthorization(t *testing.T) {
	ctx := context.Background()
	_, w, actor, kb, _, _ := evaluationFixture(t)
	second := createWorkspaceKB(t, w.db, actor, uuid.Nil, "secondary", "private", time.Now())
	source, err := w.chats.CreateSession(ctx, actor, dto.CreateChatSessionRequest{KnowledgeBaseIDs: []string{kb.String(), second.ID.String()}})
	if err != nil {
		t.Fatal(err)
	}
	sid := uuid.MustParse(source.ID)
	feedback := "negative"
	intent := "knowledge_base"
	for _, msg := range []model.ChatMessage{{SessionID: sid, Role: "user", Content: "退货规则"}, {SessionID: sid, Role: "assistant", Content: "资料不足", FeedbackRating: &feedback, Intent: &intent}} {
		msg.CreatedAt = time.Now().UTC().Add(-time.Minute)
		if err = w.db.Create(&msg).Error; err != nil {
			t.Fatal(err)
		}
	}
	overview, err := w.chats.GetQualityOverview(ctx, actor, dto.ChatQualityOverviewQuery{Scope: "multi"})
	if err != nil || overview.AnswerCount != 1 {
		t.Fatalf("overview %+v %v", overview, err)
	}
	list, err := w.chats.ListNegativeFeedback(ctx, actor, dto.ChatQualityFeedbackQuery{Scope: "multi"})
	if err != nil || list.Total != 1 || len(list.Items) != 1 {
		t.Fatalf("list %+v %v", list, err)
	}
	other := createWorkspaceUser(t, w.db, "quality-owner")
	if err = w.db.Model(&model.KnowledgeBase{}).Where("id = ?", second.ID).Update("owner_id", other.ID).Error; err != nil {
		t.Fatal(err)
	}
	overview, err = w.chats.GetQualityOverview(ctx, actor, dto.ChatQualityOverviewQuery{Scope: "multi"})
	if err != nil || overview.AnswerCount != 0 {
		t.Fatalf("revoked count %+v %v", overview, err)
	}
	list, err = w.chats.ListNegativeFeedback(ctx, actor, dto.ChatQualityFeedbackQuery{Scope: "multi"})
	if err != nil || list.Total != 0 || len(list.Items) != 0 {
		t.Fatalf("revoked list %+v %v", list, err)
	}
}
