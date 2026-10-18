package repository

import (
	"context"
	"github.com/google/uuid"
)

type DocumentVersionState struct {
	SourceID        uuid.UUID
	ID              uuid.UUID
	KnowledgeBaseID uuid.UUID
	Filename        string
	Status          string
	Depth           int
	Live            bool
	Published       bool
}

// Same forward-chain rules as retrieval, including soft-deleted intermediate links.
// The bounded depth also makes malformed cycles fail without an unbounded query.
func (r *DocumentRepository) VersionStates(ctx context.Context, ids []uuid.UUID) ([]DocumentVersionState, error) {
	var rows []DocumentVersionState
	err := r.db.WithContext(ctx).Raw(`WITH RECURSIVE successors AS (
      SELECT id AS source_id, id, knowledge_base_id, superseded_by_id, 0 AS depth FROM documents WHERE id IN ? AND deleted_at IS NULL
      UNION ALL
      SELECT p.source_id, d.id, d.knowledge_base_id, d.superseded_by_id, p.depth + 1
      FROM documents d JOIN successors p ON d.id = p.superseded_by_id AND d.knowledge_base_id = p.knowledge_base_id WHERE p.depth < 100
    ) SELECT s.source_id, d.id, d.knowledge_base_id, d.filename, d.status, s.depth,
      (d.deleted_at IS NULL) AS live, EXISTS (SELECT 1 FROM document_chunks c WHERE c.document_id = d.id AND c.knowledge_base_id = d.knowledge_base_id) AS published
      FROM successors s JOIN documents d ON d.id = s.id ORDER BY s.source_id, s.depth`, ids).Scan(&rows).Error
	return rows, err
}
