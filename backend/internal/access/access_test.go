package access

import (
	"testing"

	"github.com/google/uuid"
)

// The matrix is the phase's source of truth, so an unregistered capability must
// break the build. Without this, adding a capability constant and forgetting the
// map entry silently makes it owner-only -- which denies rather than grants, but
// still ships a capability nobody can use and no test notices.
func TestEveryCapabilityHasAMinimumRole(t *testing.T) {
	for _, capability := range Capabilities {
		if _, ok := minRole[capability]; !ok {
			t.Errorf("capability %q is not in the minRole matrix", capability)
		}
	}
	if len(minRole) != len(Capabilities) {
		t.Errorf("minRole has %d entries but Capabilities lists %d; a capability is missing from one of them", len(minRole), len(Capabilities))
	}
}

// Locks the matrix itself. Every row is a product decision recorded in
// docs/04-api-design.md (permission matrix), so a change here should
// require editing this table on purpose rather than passing quietly.
func TestMinRoleMatrix(t *testing.T) {
	want := map[Capability]Role{
		CapKnowledgeBaseRead:     RoleViewer,
		CapKnowledgeBaseSearch:   RoleViewer,
		CapChatUse:               RoleViewer,
		CapChatExport:            RoleViewer,
		CapFeedbackWrite:         RoleViewer,
		CapDocumentRead:          RoleViewer,
		CapDocumentDownload:      RoleEditor,
		CapContentWrite:          RoleEditor,
		CapContentPurge:          RoleManager,
		CapQualityRead:           RoleManager,
		CapMembersRead:           RoleManager,
		CapMembersWrite:          RoleManager,
		CapKnowledgeBaseWrite:    RoleManager,
		CapKnowledgeBaseDelete:   RoleOwner,
		CapKnowledgeBaseTransfer: RoleOwner,
	}
	for capability, wantRole := range want {
		if got := MinRole(capability); got != wantRole {
			t.Errorf("MinRole(%q) = %q, want %q", capability, got, wantRole)
		}
	}
	for _, capability := range Capabilities {
		if _, ok := want[capability]; !ok {
			t.Errorf("capability %q is not covered by this test", capability)
		}
	}
}

func TestMinRoleOfUnknownCapabilityIsOwner(t *testing.T) {
	if got := MinRole("does.not.exist"); got != RoleOwner {
		t.Fatalf("MinRole of an unregistered capability = %q, want %q so that omissions deny", got, RoleOwner)
	}
	if Allows(RoleManager, "does.not.exist") {
		t.Fatal("a manager must not hold an unregistered capability")
	}
}

// The hierarchy is the whole reason this is a ladder and not a bitmap: a higher
// role must hold every capability of every lower one, with no exceptions.
func TestHigherRolesHoldEveryLowerCapability(t *testing.T) {
	ladder := []Role{RoleNone, RoleViewer, RoleEditor, RoleManager, RoleOwner}
	for i, lower := range ladder {
		for _, higher := range ladder[i:] {
			for _, capability := range Capabilities {
				if Allows(lower, capability) && !Allows(higher, capability) {
					t.Errorf("%q holds %q but %q does not", lower, capability, higher)
				}
			}
		}
	}
}

func TestRoleNoneHoldsNothing(t *testing.T) {
	for _, capability := range Capabilities {
		if Allows(RoleNone, capability) {
			t.Errorf("RoleNone must not hold %q", capability)
		}
	}
	if got := AllowedCapabilities(RoleNone); got == nil {
		t.Fatal("AllowedCapabilities(RoleNone) is nil; want an empty slice so the JSON field is [] and not null")
	} else if len(got) != 0 {
		t.Fatalf("AllowedCapabilities(RoleNone) = %v, want empty", got)
	}
}

// An unknown stored role must rank as no access. The realistic source of one is a
// row written by a newer build; ranking it upward would grant access on the
// strength of a value this build cannot interpret.
func TestUnknownStoredRoleHasNoAccess(t *testing.T) {
	for _, role := range []Role{"member", "admin", "superuser", "Viewer", " viewer"} {
		if Rank(role) != 0 {
			t.Errorf("Rank(%q) = %d, want 0", role, Rank(role))
		}
		if Valid(role) {
			t.Errorf("Valid(%q) = true, want false", role)
		}
		for _, capability := range Capabilities {
			if Allows(role, capability) {
				t.Errorf("unknown role %q must not hold %q", role, capability)
			}
		}
	}
}

func TestAssignableRolesExcludeOwner(t *testing.T) {
	for _, role := range AssignableRoles {
		if role == RoleOwner {
			t.Fatal("RoleOwner must not be assignable: ownership comes from knowledge_bases.owner_id, and a grantable owner role would be a second source of truth")
		}
	}
	if Valid(RoleOwner) {
		t.Fatal("Valid(RoleOwner) = true; owner must not pass member-row validation")
	}
	if len(AssignableRoles) != 3 {
		t.Fatalf("AssignableRoles = %v, want exactly viewer/editor/manager", AssignableRoles)
	}
}

func TestResolve(t *testing.T) {
	owner := uuid.New()
	actor := uuid.New()

	testCases := []struct {
		name       string
		ownerID    uuid.UUID
		actorID    uuid.UUID
		memberRole Role
		want       Role
	}{
		{name: "owner", ownerID: owner, actorID: owner, want: RoleOwner},
		{
			// A stale member row must not demote the owner.
			name:       "owner with a leftover member row",
			ownerID:    owner,
			actorID:    owner,
			memberRole: RoleViewer,
			want:       RoleOwner,
		},
		{name: "member", ownerID: owner, actorID: actor, memberRole: RoleEditor, want: RoleEditor},
		{name: "no membership", ownerID: owner, actorID: actor, want: RoleNone},
		{name: "unknown stored role", ownerID: owner, actorID: actor, memberRole: "member", want: RoleNone},
		{
			// Guards the zero-value trap: an unauthenticated caller reaching this
			// with uuid.Nil must not match a knowledge base whose owner_id somehow
			// also reads as nil.
			name:    "nil actor never matches a nil owner",
			ownerID: uuid.Nil,
			actorID: uuid.Nil,
			want:    RoleNone,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := Resolve(testCase.ownerID, testCase.actorID, testCase.memberRole); got != testCase.want {
				t.Fatalf("Resolve = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestAllowedCapabilitiesGrowsWithRole(t *testing.T) {
	previous := -1
	for _, role := range []Role{RoleNone, RoleViewer, RoleEditor, RoleManager, RoleOwner} {
		count := len(AllowedCapabilities(role))
		if count <= previous {
			t.Errorf("AllowedCapabilities(%q) has %d entries, not more than the previous role's %d", role, count, previous)
		}
		previous = count
	}
	if previous != len(Capabilities) {
		t.Fatalf("owner holds %d of %d capabilities; the owner must hold all of them", previous, len(Capabilities))
	}
}
