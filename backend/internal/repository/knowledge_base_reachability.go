package repository

import (
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// reachableKnowledgeBaseCondition builds the "actor may act on this knowledge base"
// predicate for queries that span knowledge bases.
//
// Single-resource endpoints authorize in the service layer, where the decision can
// be explained and can return 403 with the role the caller needs. A list has no
// single resource to explain, and authorizing each row would mean a query per row,
// so reachability has to be part of the query. This is the one place that predicate
// is written: every list that needs it calls this rather than repeating the join.
//
// It is a subquery on the member table rather than a join, because callers already
// join knowledge_bases and a second join could add rows to their result set. The
// subquery cannot.
//
// memberRoles comes from access.MemberRolesWith(capability), never from a literal in
// the caller. An empty set is not the same as "any role": it means no member role
// holds the capability, so only the owner qualifies.
func reachableKnowledgeBaseCondition(db *gorm.DB, actorID uuid.UUID, memberRoles []string) *gorm.DB {
	condition := db.Session(&gorm.Session{NewDB: true}).Where("knowledge_bases.owner_id = ?", actorID)
	if len(memberRoles) == 0 {
		return condition
	}
	return condition.Or(
		"EXISTS (SELECT 1 FROM knowledge_base_members WHERE knowledge_base_members.knowledge_base_id = knowledge_bases.id AND knowledge_base_members.user_id = ? AND knowledge_base_members.role IN ?)",
		actorID, memberRoles,
	)
}
