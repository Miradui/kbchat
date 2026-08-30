package repository

import (
	"strings"

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

// reachableKnowledgeBaseSQL is reachableKnowledgeBaseCondition for the raw-SQL
// queries, which cannot take a *gorm.DB condition. It returns the predicate and its
// positional arguments, in order, so a caller splices both into one statement.
//
// The role list is expanded into explicit placeholders rather than an `IN ?`: these
// statements go through Raw, where GORM does not expand a slice argument, and
// interpolating the values would put strings into SQL text. The placeholders keep
// them parameters.
func reachableKnowledgeBaseSQL(actorID uuid.UUID, memberRoles []string) (string, []any) {
	if len(memberRoles) == 0 {
		return "knowledge_bases.owner_id = ?", []any{actorID}
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(memberRoles)), ", ")
	args := make([]any, 0, len(memberRoles)+2)
	args = append(args, actorID, actorID)
	for _, role := range memberRoles {
		args = append(args, role)
	}
	return `(knowledge_bases.owner_id = ?
       OR EXISTS (
           SELECT 1 FROM knowledge_base_members
           WHERE knowledge_base_members.knowledge_base_id = knowledge_bases.id
             AND knowledge_base_members.user_id = ?
             AND knowledge_base_members.role IN (` + placeholders + `)
       ))`, args
}
