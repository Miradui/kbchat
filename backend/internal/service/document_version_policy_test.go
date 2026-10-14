package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"testing"
)

func TestVersionPolicyDefaultsPreservesOmittedValueAndRequiresKBWrite(t *testing.T) {
	s := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, s.db, "version-policy")
	kb, err := s.kbs.Create(ctx, owner.ID, dto.KnowledgeBaseRequest{Name: "policy"})
	if err != nil || kb.DocumentVersionPolicy != "all" {
		t.Fatalf("default: %+v %v", kb, err)
	}
	current := "current"
	next, err := s.kbs.Update(ctx, owner.ID, uuid.MustParse(kb.ID), dto.KnowledgeBaseRequest{Name: kb.Name, DocumentVersionPolicy: &current})
	if err != nil || next.DocumentVersionPolicy != "current" {
		t.Fatalf("update: %+v %v", next, err)
	}
	next, err = s.kbs.Update(ctx, owner.ID, uuid.MustParse(kb.ID), dto.KnowledgeBaseRequest{Name: "renamed"})
	if err != nil || next.DocumentVersionPolicy != "current" {
		t.Fatalf("omitted policy reset: %+v %v", next, err)
	}
	if next.RetrievalConfig != kb.RetrievalConfig {
		t.Fatal("version setting changed retrieval quality parameters")
	}
	invalid := "latest-ish"
	_, err = s.kbs.Update(ctx, owner.ID, uuid.MustParse(kb.ID), dto.KnowledgeBaseRequest{Name: "renamed", DocumentVersionPolicy: &invalid})
	assertAppError(t, err, "VALIDATION_ERROR")
	member := createWorkspaceUser(t, s.db, "policy-editor")
	if err := s.db.Create(&model.KnowledgeBaseMember{KnowledgeBaseID: uuid.MustParse(kb.ID), UserID: member.ID, Role: "editor"}).Error; err != nil {
		t.Fatal(err)
	}
	_, err = s.kbs.Update(ctx, member.ID, uuid.MustParse(kb.ID), dto.KnowledgeBaseRequest{Name: "renamed", DocumentVersionPolicy: &current})
	if err == nil {
		t.Fatal("content editor changed knowledge-base settings")
	}
	listed, err := s.kbs.List(ctx, owner.ID)
	if err != nil || len(listed.Items) != 1 || listed.Items[0].DocumentVersionPolicy != "current" {
		t.Fatalf("list policy: %+v %v", listed, err)
	}
}
