package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/dto"
)

func TestKnowledgeBaseTagsCRUDAndUsageRules(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")

	created, err := services.tags.Create(ctx, owner.ID, "product")
	if err != nil {
		t.Fatalf("create tag: %v", err)
	}
	if created.Name != "product" {
		t.Fatalf("expected created tag name, got %#v", created)
	}

	list, err := services.tags.List(ctx, owner.ID)
	if err != nil {
		t.Fatalf("list tags: %v", err)
	}
	if len(list.Items) != 1 || list.Items[0].ID != created.ID || list.Items[0].Name != "product" {
		t.Fatalf("expected one owner tag, got %#v", list.Items)
	}

	updated, err := services.tags.Update(ctx, owner.ID, created.ID, "manual")
	if err != nil {
		t.Fatalf("update tag: %v", err)
	}
	if updated.Name != "manual" {
		t.Fatalf("expected updated tag name, got %#v", updated)
	}

	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	detail, err := services.kbs.Get(ctx, owner.ID, kb.ID)
	if err != nil {
		t.Fatalf("get knowledge base before assign tags: %v", err)
	}
	if _, err := services.kbs.Update(ctx, owner.ID, kb.ID, mustWorkspaceKnowledgeBaseRequest(t, detail, []uuid.UUID{created.ID})); err != nil {
		t.Fatalf("assign tag to knowledge base: %v", err)
	}

	if err := services.tags.Delete(ctx, owner.ID, created.ID); err == nil {
		t.Fatalf("expected deleting in-use tag to be rejected")
	}

	detail, err = services.kbs.Get(ctx, owner.ID, kb.ID)
	if err != nil {
		t.Fatalf("get knowledge base before clear tags: %v", err)
	}
	if _, err := services.kbs.Update(ctx, owner.ID, kb.ID, mustWorkspaceKnowledgeBaseRequest(t, detail, []uuid.UUID{})); err != nil {
		t.Fatalf("clear tag bindings: %v", err)
	}

	if err := services.tags.Delete(ctx, owner.ID, created.ID); err != nil {
		t.Fatalf("delete unused tag: %v", err)
	}
}

func TestKnowledgeBaseTagsSupportOwnerIsolationAndFiltering(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")

	productTag, err := services.tags.Create(ctx, owner.ID, "product")
	if err != nil {
		t.Fatalf("create product tag: %v", err)
	}
	supportTag, err := services.tags.Create(ctx, owner.ID, "support")
	if err != nil {
		t.Fatalf("create support tag: %v", err)
	}
	foreignTag, err := services.tags.Create(ctx, other.ID, "foreign")
	if err != nil {
		t.Fatalf("create foreign tag: %v", err)
	}

	createdA, err := services.kbs.Create(ctx, owner.ID, dto.KnowledgeBaseRequest{
		Name:        "product-kb",
		Description: "product docs",
		Visibility:  "private",
		TagIDs:      uuidSlicePtr(productTag.ID),
	})
	if err != nil {
		t.Fatalf("create tagged knowledge base: %v", err)
	}
	if len(createdA.Tags) != 1 || createdA.Tags[0].ID != productTag.ID {
		t.Fatalf("expected create response to include product tag, got %#v", createdA.Tags)
	}

	createdB, err := services.kbs.Create(ctx, owner.ID, dto.KnowledgeBaseRequest{
		Name:        "support-kb",
		Description: "support docs",
		Visibility:  "private",
		TagIDs:      uuidSlicePtr(supportTag.ID),
	})
	if err != nil {
		t.Fatalf("create second tagged knowledge base: %v", err)
	}

	kbAID := mustParseUUID(t, createdA.ID)
	if _, err := services.kbs.Update(ctx, owner.ID, kbAID, dto.KnowledgeBaseRequest{
		Name:        createdA.Name,
		Description: createdA.Description,
		CategoryID:  nil,
		Visibility:  createdA.Visibility,
		TagIDs:      uuidSlicePtr(productTag.ID, supportTag.ID),
	}); err != nil {
		t.Fatalf("update knowledge base tags: %v", err)
	}

	detail, err := services.kbs.Get(ctx, owner.ID, kbAID)
	if err != nil {
		t.Fatalf("get tagged knowledge base: %v", err)
	}
	if len(detail.Tags) != 2 {
		t.Fatalf("expected detail tags, got %#v", detail.Tags)
	}

	filtered, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		TagIDs:   []uuid.UUID{productTag.ID},
		Page:     1,
		PageSize: 10,
	})
	if err != nil {
		t.Fatalf("filter knowledge bases by product tag: %v", err)
	}
	if filtered.Total != 1 || filtered.Items[0].ID != createdA.ID {
		t.Fatalf("expected only product-tagged knowledge base, got %#v", filtered)
	}

	filteredSupport, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		TagIDs:   []uuid.UUID{supportTag.ID},
		Page:     1,
		PageSize: 10,
	})
	if err != nil {
		t.Fatalf("filter knowledge bases by support tag: %v", err)
	}
	if filteredSupport.Total != 2 {
		t.Fatalf("expected two support-tagged knowledge bases, got %#v", filteredSupport)
	}
	if filteredSupport.Items[0].ID != createdA.ID && filteredSupport.Items[1].ID != createdA.ID {
		t.Fatalf("expected updated knowledge base in support filter, got %#v", filteredSupport.Items)
	}
	if filteredSupport.Items[0].ID != createdB.ID && filteredSupport.Items[1].ID != createdB.ID {
		t.Fatalf("expected second knowledge base in support filter, got %#v", filteredSupport.Items)
	}

	if _, err := services.kbs.Update(ctx, owner.ID, kbAID, dto.KnowledgeBaseRequest{
		Name:        createdA.Name,
		Description: createdA.Description,
		Visibility:  createdA.Visibility,
		TagIDs:      uuidSlicePtr(foreignTag.ID),
	}); err == nil {
		t.Fatalf("expected cross-owner tag binding to be rejected")
	}
}

func mustWorkspaceKnowledgeBaseRequest(t *testing.T, res *dto.KnowledgeBaseResponse, tagIDs []uuid.UUID) dto.KnowledgeBaseRequest {
	t.Helper()

	var categoryID *uuid.UUID
	if res.CategoryID != nil {
		parsed := mustParseUUID(t, *res.CategoryID)
		categoryID = &parsed
	}

	return dto.KnowledgeBaseRequest{
		Name:            res.Name,
		Description:     res.Description,
		CategoryID:      categoryID,
		Visibility:      res.Visibility,
		RetrievalConfig: &res.RetrievalConfig,
		TagIDs:          uuidSlicePtr(tagIDs...),
	}
}

func uuidSlicePtr(ids ...uuid.UUID) *[]uuid.UUID {
	values := append([]uuid.UUID(nil), ids...)
	return &values
}
