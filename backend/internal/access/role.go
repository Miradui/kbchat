// Package access decides what a user may do with a knowledge base.
//
// It holds the capability matrix and nothing else: no database, no HTTP, no
// service dependencies. Authorization used to live in repository predicates
// (`WHERE knowledge_bases.owner_id = ?`), which made it invisible and impossible
// to test on its own. Keeping the decision here means the matrix can be read in
// one file and asserted directly.
package access

// Role is a caller's standing on one knowledge base.
//
// The roles form a linear hierarchy rather than a set of independent permission
// bits. A bitmap would express combinations nobody asked for, turn every check
// into a set operation, and produce a UI no user could reason about. A ladder can
// be explained in one sentence: an editor may do everything a viewer may, plus
// change content.
type Role string

const (
	// RoleNone is a caller with no standing at all. It is not a stored value.
	RoleNone Role = ""
	// RoleViewer may read and ask questions, and change nothing.
	RoleViewer Role = "viewer"
	// RoleEditor may additionally add, replace and remove content.
	RoleEditor Role = "editor"
	// RoleManager may additionally manage members and read operational data.
	RoleManager Role = "manager"
	// RoleOwner is derived from knowledge_bases.owner_id, never from the member
	// table. Ownership is not a grant, and storing it as a membership row would
	// create a second source of truth that can disagree with the first.
	RoleOwner Role = "owner"
)

// AssignableRoles are the values a member row may hold, in ascending order.
//
// RoleOwner is absent on purpose: it cannot be granted. Kept in sync with the
// CHECK constraint in migrations/020_member_role_matrix.sql; a test parses the
// migration to catch drift.
var AssignableRoles = []Role{RoleViewer, RoleEditor, RoleManager}

// ranks orders the hierarchy. RoleNone is 0 so an unknown stored value ranks as
// no access rather than as some access.
var ranks = map[Role]int{
	RoleNone:    0,
	RoleViewer:  1,
	RoleEditor:  2,
	RoleManager: 3,
	RoleOwner:   4,
}

// Rank reports the position of a role in the hierarchy. Unknown values rank 0.
//
// Failing closed matters here: a role string that this build does not recognise
// is most likely written by a newer build, and guessing it upward would grant
// access on the strength of a value this code cannot interpret.
func Rank(role Role) int {
	return ranks[role]
}

// Valid reports whether a role may be stored on a member row.
func Valid(role Role) bool {
	for _, candidate := range AssignableRoles {
		if role == candidate {
			return true
		}
	}
	return false
}

// AtLeast reports whether role holds every permission of minimum.
func AtLeast(role, minimum Role) bool {
	return Rank(role) >= Rank(minimum)
}
