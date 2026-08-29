package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
)

func TestGlobalSearchReturnsFairStablePageAndTotal(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "search-owner")

	for i := 0; i < 3; i++ {
		kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "policy knowledge base "+string(rune('A'+i)), "private", time.Now().Add(time.Duration(i)*time.Minute))
		document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "policy-document-"+string(rune('A'+i))+".md", "completed")
		createWorkspaceDocumentChunk(t, services.db, kb.ID, document.ID, i, "policy chunk content")
	}

	response, err := services.search.Search(ctx, owner.ID, dto.GlobalSearchRequest{
		Query:    "policy",
		Type:     "all",
		Page:     1,
		PageSize: 3,
	})
	if err != nil {
		t.Fatalf("global search: %v", err)
	}
	if response.Total != 9 || response.Page != 1 || response.PageSize != 3 {
		t.Fatalf("expected total/page metadata, got %#v", response)
	}
	if len(response.Items) != 3 {
		t.Fatalf("expected first page of 3 items, got %#v", response.Items)
	}
	seen := map[string]bool{}
	for _, item := range response.Items {
		seen[item.Type] = true
	}
	if !seen["knowledgeBase"] || !seen["document"] || !seen["chunk"] {
		t.Fatalf("expected all result types on fair first page, got %#v", response.Items)
	}
}

func TestGlobalSearchFiltersTypeAndKeepsTotalOnLaterPage(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "filtered-search-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "policy kb", "private", time.Now())
	for i := 0; i < 3; i++ {
		createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "policy-"+string(rune('A'+i))+".md", "completed")
	}

	response, err := services.search.Search(ctx, owner.ID, dto.GlobalSearchRequest{
		Query:    "policy",
		Type:     "document",
		Page:     2,
		PageSize: 2,
	})
	if err != nil {
		t.Fatalf("filtered global search: %v", err)
	}
	if response.Total != 3 || len(response.Items) != 1 || response.Items[0].Type != "document" {
		t.Fatalf("expected filtered second page with stable total, got %#v", response)
	}
}

func TestGlobalSearchRejectsBlankQueryAndInvalidType(t *testing.T) {
	services := newWorkspaceTestServices(t)
	owner := uuid.New()

	for _, request := range []dto.GlobalSearchRequest{
		{Query: "   ", Type: "all"},
		{Query: "policy", Type: "unknown"},
	} {
		_, err := services.search.Search(context.Background(), owner, request)
		var appErr *apperror.Error
		if !errors.As(err, &appErr) || appErr.Status != 400 {
			t.Fatalf("expected validation error for %#v, got %#v", request, err)
		}
	}
}
