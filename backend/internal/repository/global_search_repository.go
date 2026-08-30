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

// globalSearchMatchesSQL is the match CTE, parameterized by one reachability
// predicate per result type.
//
// Three separate predicates rather than one, because the three row types are not
// governed by the same capability: a knowledge base row is kb.read, a document row
// is document.read, a chunk row is kb.search. They resolve to the same role today,
// and writing them separately is what keeps that a fact about the matrix rather than
// an assumption baked into this query.
func globalSearchMatchesSQL(kbPredicate, documentPredicate, chunkPredicate string) string {
	return `
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
    WHERE ` + kbPredicate + `
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
    WHERE ` + documentPredicate + `
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
    WHERE ` + chunkPredicate + `
      AND knowledge_bases.deleted_at IS NULL
      AND documents.deleted_at IS NULL
      AND LOWER(document_chunks.content) LIKE ?
)
`
}

// GlobalSearchScope is the set of member roles that may see each row type, one entry
// per capability the search spans. The service builds it from the matrix.
type GlobalSearchScope struct {
	KnowledgeBaseRoles []string
	DocumentRoles      []string
	ChunkRoles         []string
}

func (r *GlobalSearchRepository) Search(
	ctx context.Context,
	actorID uuid.UUID,
	scope GlobalSearchScope,
	query string,
	resultType string,
	offset int,
	limit int,
) ([]GlobalSearchResult, int64, error) {
	like := "%" + strings.ToLower(query) + "%"
	kbPredicate, kbArgs := reachableKnowledgeBaseSQL(actorID, scope.KnowledgeBaseRoles)
	documentPredicate, documentArgs := reachableKnowledgeBaseSQL(actorID, scope.DocumentRoles)
	chunkPredicate, chunkArgs := reachableKnowledgeBaseSQL(actorID, scope.ChunkRoles)
	matchesSQL := globalSearchMatchesSQL(kbPredicate, documentPredicate, chunkPredicate)

	// Argument order follows the statement: each block's predicate arguments come
	// before its own LIKE arguments.
	baseArgs := make([]any, 0, len(kbArgs)+len(documentArgs)+len(chunkArgs)+4)
	baseArgs = append(baseArgs, kbArgs...)
	baseArgs = append(baseArgs, like, like)
	baseArgs = append(baseArgs, documentArgs...)
	baseArgs = append(baseArgs, like)
	baseArgs = append(baseArgs, chunkArgs...)
	baseArgs = append(baseArgs, like)

	var total int64
	countArgs := append(append([]any{}, baseArgs...), resultType, resultType)
	if err := r.db.WithContext(ctx).Raw(
		matchesSQL+`SELECT COUNT(*) FROM matches WHERE (? = 'all' OR result_type = ?)`,
		countArgs...,
	).Scan(&total).Error; err != nil {
		return nil, 0, err
	}

	queryArgs := append(append([]any{}, baseArgs...), resultType, resultType, limit, offset)
	var results []GlobalSearchResult
	err := r.db.WithContext(ctx).Raw(matchesSQL+`
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
	actorID uuid.UUID,
	scope GlobalSearchScope,
	query string,
	limit int,
) ([]SearchSuggestion, error) {
	like := "%" + strings.ToLower(query) + "%"
	kbPredicate, kbArgs := reachableKnowledgeBaseSQL(actorID, scope.KnowledgeBaseRoles)
	documentPredicate, documentArgs := reachableKnowledgeBaseSQL(actorID, scope.DocumentRoles)
	args := make([]any, 0, len(kbArgs)+len(documentArgs)+3)
	args = append(args, kbArgs...)
	args = append(args, like)
	args = append(args, documentArgs...)
	args = append(args, like, limit)

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
    WHERE `+kbPredicate+`
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
    WHERE `+documentPredicate+`
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
LIMIT ?`, args...).Scan(&results).Error
	if err != nil {
		return nil, err
	}
	return results, nil
}
