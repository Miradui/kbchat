package access

import "github.com/google/uuid"

// Resolve reports the actor's standing on a knowledge base.
//
// memberRole is the stored role of the actor's member row, or RoleNone when there
// is no row. Owner wins outright and is never compared against the member table:
// an owner who also has a stale member row must not be demoted by it.
//
// Callers pass the stored string as a Role. An unrecognised value ranks 0 and so
// resolves to RoleNone -- see Rank for why that direction is the safe one.
func Resolve(ownerID, actorID uuid.UUID, memberRole Role) Role {
	if actorID != uuid.Nil && ownerID == actorID {
		return RoleOwner
	}
	if !Valid(memberRole) {
		return RoleNone
	}
	return memberRole
}
