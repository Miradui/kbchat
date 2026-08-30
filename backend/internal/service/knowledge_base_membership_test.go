package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/dto"
)

// Before this phase a member could not see the knowledge base they had been added
// to in any list scope, because the workspace query filtered on owner_id alone.
// The whole capability matrix is unobservable while that is true: an editor with
// no way to reach the base cannot exercise a single capability.
func TestWorkspaceListIncludesKnowledgeBasesSharedWithTheActor(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	editor := createWorkspaceUser(t, services.db, "editor")
	stranger := createWorkspaceUser(t, services.db, "stranger")
	shared := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "shared-kb", "private", time.Now())
	createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "private-kb", "private", time.Now())

	if _, err := services.kbs.AddMember(ctx, owner.ID, shared.ID, dto.KnowledgeBaseMemberRequest{
		UserID: editor.ID,
		Role:   string(access.RoleEditor),
	}); err != nil {
		t.Fatalf("add editor: %v", err)
	}

	list, err := services.kbs.ListWorkspace(ctx, editor.ID, dto.KnowledgeBaseListQuery{})
	if err != nil {
		t.Fatalf("list as editor: %v", err)
	}
	if list.Total != 1 || len(list.Items) != 1 {
		t.Fatalf("expected the editor to see exactly the shared knowledge base, got total=%d items=%d", list.Total, len(list.Items))
	}
	if list.Items[0].ID != shared.ID.String() {
		t.Fatalf("expected %s, got %s", shared.ID, list.Items[0].ID)
	}
	if list.Items[0].EffectiveRole != string(access.RoleEditor) {
		t.Fatalf("effectiveRole = %q, want %q", list.Items[0].EffectiveRole, access.RoleEditor)
	}

	// The owner's own view must not change shape: they still see both, as owner.
	ownerList, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{})
	if err != nil {
		t.Fatalf("list as owner: %v", err)
	}
	if ownerList.Total != 2 {
		t.Fatalf("expected the owner to still see both knowledge bases, got %d", ownerList.Total)
	}
	for _, item := range ownerList.Items {
		if item.EffectiveRole != string(access.RoleOwner) {
			t.Fatalf("owner's effectiveRole = %q, want owner", item.EffectiveRole)
		}
	}

	strangerList, err := services.kbs.ListWorkspace(ctx, stranger.ID, dto.KnowledgeBaseListQuery{})
	if err != nil {
		t.Fatalf("list as stranger: %v", err)
	}
	if strangerList.Total != 0 || len(strangerList.Items) != 0 {
		t.Fatalf("expected a stranger to see nothing, got total=%d items=%d", strangerList.Total, len(strangerList.Items))
	}
}

// The membership join sits on a query that groups by the actor's member role, so
// a join that matched any member rather than the actor would emit one row per
// distinct role and list the same knowledge base several times, each with someone
// else's role. Joining on the member table's own primary key is what prevents it.
func TestWorkspaceListIsNotDuplicatedByOtherPeoplesMemberships(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	viewer := createWorkspaceUser(t, services.db, "viewer")
	manager := createWorkspaceUser(t, services.db, "manager")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "counted-kb", "private", time.Now())
	createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "a.md", "completed")
	createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "b.md", "completed")

	for user, role := range map[uuid.UUID]access.Role{viewer.ID: access.RoleViewer, manager.ID: access.RoleManager} {
		if _, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
			UserID: user,
			Role:   string(role),
		}); err != nil {
			t.Fatalf("add member: %v", err)
		}
	}

	for _, actor := range []struct {
		name string
		id   uuid.UUID
		role access.Role
	}{
		{"owner", owner.ID, access.RoleOwner},
		{"viewer", viewer.ID, access.RoleViewer},
		{"manager", manager.ID, access.RoleManager},
	} {
		list, err := services.kbs.ListWorkspace(ctx, actor.id, dto.KnowledgeBaseListQuery{})
		if err != nil {
			t.Fatalf("list as %s: %v", actor.name, err)
		}
		if len(list.Items) != 1 || list.Total != 1 {
			t.Fatalf("%s: expected one row for one knowledge base, got items=%d total=%d", actor.name, len(list.Items), list.Total)
		}
		if list.Items[0].EffectiveRole != string(actor.role) {
			t.Fatalf("%s: effectiveRole = %q, want %q", actor.name, list.Items[0].EffectiveRole, actor.role)
		}
		if list.Items[0].DocumentCount != 2 {
			t.Fatalf("%s: documentCount = %d, want 2", actor.name, list.Items[0].DocumentCount)
		}
	}
}

// "managed" was accepted as a scope but never filtered on anything, so it returned
// the same rows as "all". A manager expects it to mean "the bases I administer".
func TestManagedScopeReturnsOwnedAndManagedKnowledgeBases(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	manager := createWorkspaceUser(t, services.db, "manager")
	managed := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "managed-kb", "private", time.Now())
	watched := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "watched-kb", "private", time.Now())
	ownedByManager := createWorkspaceKB(t, services.db, manager.ID, uuid.Nil, "own-kb", "private", time.Now())

	if _, err := services.kbs.AddMember(ctx, owner.ID, managed.ID, dto.KnowledgeBaseMemberRequest{
		UserID: manager.ID,
		Role:   string(access.RoleManager),
	}); err != nil {
		t.Fatalf("add manager: %v", err)
	}
	if _, err := services.kbs.AddMember(ctx, owner.ID, watched.ID, dto.KnowledgeBaseMemberRequest{
		UserID: manager.ID,
		Role:   string(access.RoleViewer),
	}); err != nil {
		t.Fatalf("add viewer: %v", err)
	}

	list, err := services.kbs.ListWorkspace(ctx, manager.ID, dto.KnowledgeBaseListQuery{Scope: "managed"})
	if err != nil {
		t.Fatalf("list managed: %v", err)
	}
	seen := map[string]string{}
	for _, item := range list.Items {
		seen[item.ID] = item.EffectiveRole
	}
	if role, ok := seen[managed.ID.String()]; !ok || role != string(access.RoleManager) {
		t.Fatalf("expected the managed knowledge base with role manager, got %v", seen)
	}
	// Owners administer their own bases by definition; excluding them would read as
	// a bug rather than as a filter.
	if role, ok := seen[ownedByManager.ID.String()]; !ok || role != string(access.RoleOwner) {
		t.Fatalf("expected the actor's own knowledge base in the managed scope, got %v", seen)
	}
	if _, ok := seen[watched.ID.String()]; ok {
		t.Fatalf("a viewer membership must not appear in the managed scope, got %v", seen)
	}

	// "created" is authorship, so a base someone else owns must not appear even when
	// the actor manages it.
	created, err := services.kbs.ListWorkspace(ctx, manager.ID, dto.KnowledgeBaseListQuery{Scope: "created"})
	if err != nil {
		t.Fatalf("list created: %v", err)
	}
	if len(created.Items) != 1 || created.Items[0].ID != ownedByManager.ID.String() {
		t.Fatalf("expected only the actor's own knowledge base in the created scope, got %#v", created.Items)
	}
}

// Revoking a membership has to take the knowledge base away again. A cached role,
// a stale row or a query that only checks for a row's existence would all leave
// the former member with access.
func TestRemovingAMemberRevokesListVisibilityAndAccess(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	viewer := createWorkspaceUser(t, services.db, "viewer")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "revoked-kb", "private", time.Now())

	if _, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
		UserID: viewer.ID,
		Role:   string(access.RoleViewer),
	}); err != nil {
		t.Fatalf("add viewer: %v", err)
	}
	if _, err := services.kbs.Get(ctx, viewer.ID, kb.ID); err != nil {
		t.Fatalf("viewer get before revoke: %v", err)
	}

	if err := services.kbs.RemoveMember(ctx, owner.ID, kb.ID, viewer.ID); err != nil {
		t.Fatalf("remove member: %v", err)
	}

	// 404 rather than 403: a former member must not be able to confirm the base
	// still exists.
	_, err := services.kbs.Get(ctx, viewer.ID, kb.ID)
	assertAppError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")
	list, listErr := services.kbs.ListWorkspace(ctx, viewer.ID, dto.KnowledgeBaseListQuery{})
	if listErr != nil {
		t.Fatalf("list after revoke: %v", listErr)
	}
	if list.Total != 0 {
		t.Fatalf("expected the former member to see nothing, got %d", list.Total)
	}
}
