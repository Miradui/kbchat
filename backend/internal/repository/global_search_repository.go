package repository

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type GlobalSearchRepository struct {
	db *gorm.DB
}

func NewGlobalSearchRepository(db *gorm.DB) *GlobalSearchRepository {
	return &GlobalSearchRepository{db: db}
}

type GlobalSearchResult struct {
	Type              string
	ID                uuid.UUID
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	DocumentID        *uuid.UUID
	Filename          string
	Title             string
	Snippet           string
}

const globalSearchMatchesSQL = `
WITH matches AS (
    SELECT 'knowledgeBase' AS result_type,
        knowledge_bases.id AS id,
        knowledge_bases.id AS knowledge_base_id,
        knowledge_bases.name AS knowledge_base_name,
        NULL AS document_id,
        '' AS filename,
        knowledge_bases.name AS title,
        COALESCE(knowledge_bases.description, '') AS snippet,
        knowledge_bases.updated_at AS sort_at,
        1 AS type_rank
    FROM knowledge_bases
    WHERE knowledge_bases.owner_id = ?
      AND knowledge_bases.deleted_at IS NULL
      AND (LOWER(knowledge_bases.name) LIKE ? OR LOWER(knowledge_bases.description) LIKE ?)

    UNION ALL

    SELECT 'document' AS result_type,
        documents.id AS id,
        documents.knowledge_base_id AS knowledge_base_id,
        knowledge_bases.name AS knowledge_base_name,
        documents.id AS document_id,
        documents.filename AS filename,
        documents.filename AS title,
        COALESCE(documents.status, '') AS snippet,
        documents.updated_at AS sort_at,
        2 AS type_rank
    FROM documents
    JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id
    WHERE knowledge_bases.owner_id = ?
      AND knowledge_bases.deleted_at IS NULL
      AND documents.deleted_at IS NULL
      AND LOWER(documents.filename) LIKE ?

    UNION ALL

    SELECT 'chunk' AS result_type,
        document_chunks.id AS id,
        document_chunks.knowledge_base_id AS knowledge_base_id,
        knowledge_bases.name AS knowledge_base_name,
        document_chunks.document_id AS document_id,
        documents.filename AS filename,
        documents.filename AS title,
        document_chunks.content AS snippet,
        document_chunks.created_at AS sort_at,
        3 AS type_rank
    FROM document_chunks
    JOIN knowledge_bases ON knowledge_bases.id = document_chunks.knowledge_base_id
    JOIN documents ON documents.id = document_chunks.document_id
    WHERE knowledge_bases.owner_id = ?
      AND knowledge_bases.deleted_at IS NULL
      AND documents.deleted_at IS NULL
      AND LOWER(document_chunks.content) LIKE ?
)
`

func (r *GlobalSearchRepository) Search(
	ctx context.Context,
	ownerID uuid.UUID,
	query string,
	resultType string,
	offset int,
	limit int,
) ([]GlobalSearchResult, int64, error) {
	like := "%" + strings.ToLower(query) + "%"
	baseArgs := []any{ownerID, like, like, ownerID, like, ownerID, like}

	var total int64
	countArgs := append(append([]any{}, baseArgs...), resultType, resultType)
	if err := r.db.WithContext(ctx).Raw(
		globalSearchMatchesSQL+`SELECT COUNT(*) FROM matches WHERE (? = 'all' OR result_type = ?)`,
		countArgs...,
	).Scan(&total).Error; err != nil {
		return nil, 0, err
	}

	queryArgs := append(append([]any{}, baseArgs...), resultType, resultType, limit, offset)
	var results []GlobalSearchResult
	err := r.db.WithContext(ctx).Raw(globalSearchMatchesSQL+`
, ranked AS (
    SELECT matches.*,
        ROW_NUMBER() OVER (
            PARTITION BY result_type
            ORDER BY sort_at DESC, id ASC
        ) AS type_position
    FROM matches
    WHERE (? = 'all' OR result_type = ?)
)
SELECT result_type AS type,
    id,
    knowledge_base_id,
    knowledge_base_name,
    document_id,
    filename,
    title,
    snippet
FROM ranked
ORDER BY type_position ASC, type_rank ASC, sort_at DESC, id ASC
LIMIT ? OFFSET ?`, queryArgs...).Scan(&results).Error
	if err != nil {
		return nil, 0, err
	}
	return results, total, nil
}

type SearchSuggestion struct {
	Type              string
	ID                uuid.UUID
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	DocumentID        *uuid.UUID
	Title             string
}

// Suggest is the title-only half of Search: knowledge base names and document
// filenames, no chunk content and no snippet. That is what keeps a keystroke in
// the command palette cheaper than a results page.
func (r *GlobalSearchRepository) Suggest(
	ctx context.Context,
	ownerID uuid.UUID,
	query string,
	limit int,
) ([]SearchSuggestion, error) {
	like := "%" + strings.ToLower(query) + "%"
	var results []SearchSuggestion
	err := r.db.WithContext(ctx).Raw(`
WITH matches AS (
    SELECT 'knowledgeBase' AS result_type,
        knowledge_bases.id AS id,
        knowledge_bases.id AS knowledge_base_id,
        knowledge_bases.name AS knowledge_base_name,
        NULL AS document_id,
        knowledge_bases.name AS title,
        knowledge_bases.updated_at AS sort_at,
        1 AS type_rank
    FROM knowledge_bases
    WHERE knowledge_bases.owner_id = ?
      AND knowledge_bases.deleted_at IS NULL
      AND LOWER(knowledge_bases.name) LIKE ?

    UNION ALL

    SELECT 'document' AS result_type,
        documents.id AS id,
        documents.knowledge_base_id AS knowledge_base_id,
        knowledge_bases.name AS knowledge_base_name,
        documents.id AS document_id,
        documents.filename AS title,
        documents.updated_at AS sort_at,
        2 AS type_rank
    FROM documents
    JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id
    WHERE knowledge_bases.owner_id = ?
      AND knowledge_bases.deleted_at IS NULL
      AND documents.deleted_at IS NULL
      AND LOWER(documents.filename) LIKE ?
)
SELECT result_type AS type,
    id,
    knowledge_base_id,
    knowledge_base_name,
    document_id,
    title
FROM matches
ORDER BY type_rank ASC, sort_at DESC, id ASC
LIMIT ?`, ownerID, like, ownerID, like, limit).Scan(&results).Error
	if err != nil {
		return nil, err
	}
	return results, nil
}
