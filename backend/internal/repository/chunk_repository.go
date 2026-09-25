package repository

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/document/lexer"
	"kbchat/backend/internal/model"
)

type SearchResult struct {
	ChunkID     uuid.UUID
	DocumentID  uuid.UUID
	Filename    string
	Content     string
	PageNumber  *int
	VectorScore float64
	// KeywordScore is set only for chunks the keyword stage returned; FusionScore
	// only when both stages ran and were fused. Nil means the stage did not
	// see the chunk, which is different from a score of zero.
	KeywordScore *float64
	FusionScore  *float64
	RerankScore  *float64
}

type ChunkRepository struct {
	db *gorm.DB
}

func NewChunkRepository(db *gorm.DB) *ChunkRepository {
	return &ChunkRepository{db: db}
}

func (r *ChunkRepository) DeleteByDocument(ctx context.Context, documentID uuid.UUID) error {
	return r.db.WithContext(ctx).Where("document_id = ?", documentID).Delete(&model.DocumentChunk{}).Error
}

func (r *ChunkRepository) CreateBatch(ctx context.Context, chunks []model.DocumentChunk) error {
	if len(chunks) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := validateChunkOwnership(tx, chunks); err != nil {
			return err
		}
		return tx.CreateInBatches(chunks, 50).Error
	})
}

func (r *ChunkRepository) ReplaceByDocument(ctx context.Context, documentID uuid.UUID, chunks []model.DocumentChunk) error {
	if err := validateReplacementChunks(documentID, chunks); err != nil {
		return err
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := validateChunkOwnership(tx, chunks); err != nil {
			return err
		}
		return replaceDocumentChunks(tx, documentID, chunks)
	})
}

// PublishByDocument atomically publishes a complete replacement index and the
// successful terminal state of the exact job that produced it. It linearizes
// against CancelActiveJob on the document row: cancellation that committed
// first prevents all chunk writes, while a publication that commits first makes
// a later cancel non-cancellable because the job is already completed.
func (r *ChunkRepository) PublishByDocument(
	ctx context.Context,
	documentID uuid.UUID,
	jobID uuid.UUID,
	chunks []model.DocumentChunk,
) error {
	if err := validateReplacementChunks(documentID, chunks); err != nil {
		return err
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := guardRunningDocumentJob(tx, documentID, jobID); err != nil {
			return err
		}
		if err := validateChunkOwnership(tx, chunks); err != nil {
			return err
		}
		if err := replaceDocumentChunks(tx, documentID, chunks); err != nil {
			return err
		}

		now := time.Now()
		documentResult := tx.Model(&model.Document{}).
			Where("id = ?", documentID).
			Updates(map[string]any{
				"status":        "completed",
				"error_message": "",
				"updated_at":    now,
			})
		if documentResult.Error != nil {
			return documentResult.Error
		}
		if documentResult.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}

		jobResult := tx.Model(&model.DocumentJob{}).
			Where(
				"id = ? AND document_id = ? AND status = ? AND job_type = ?",
				jobID, documentID, "running", "process_document",
			).
			Updates(map[string]any{
				"status":        "completed",
				"progress":      100,
				"error_message": "",
				"locked_at":     nil,
				"updated_at":    now,
			})
		if jobResult.Error != nil {
			return jobResult.Error
		}
		if jobResult.RowsAffected != 1 {
			return ErrDocumentJobCancelled
		}
		return nil
	})
}

func validateReplacementChunks(documentID uuid.UUID, chunks []model.DocumentChunk) error {
	for index := range chunks {
		if chunks[index].DocumentID != documentID {
			return fmt.Errorf("replacement chunk %d belongs to document %s, expected %s", index, chunks[index].DocumentID, documentID)
		}
	}
	return nil
}

func replaceDocumentChunks(tx *gorm.DB, documentID uuid.UUID, chunks []model.DocumentChunk) error {
	if err := tx.Where("document_id = ?", documentID).Delete(&model.DocumentChunk{}).Error; err != nil {
		return err
	}
	if len(chunks) == 0 {
		return nil
	}
	return tx.CreateInBatches(chunks, 50).Error
}

func validateChunkOwnership(tx *gorm.DB, chunks []model.DocumentChunk) error {
	if len(chunks) == 0 {
		return nil
	}

	documentIDs := make([]uuid.UUID, 0, len(chunks))
	seen := make(map[uuid.UUID]struct{}, len(chunks))
	for _, chunk := range chunks {
		if _, ok := seen[chunk.DocumentID]; ok {
			continue
		}
		seen[chunk.DocumentID] = struct{}{}
		documentIDs = append(documentIDs, chunk.DocumentID)
	}

	type documentOwnership struct {
		ID              uuid.UUID
		KnowledgeBaseID uuid.UUID
	}
	var documents []documentOwnership
	if err := tx.Model(&model.Document{}).
		Select("id", "knowledge_base_id").
		Where("id IN ?", documentIDs).
		Find(&documents).Error; err != nil {
		return err
	}
	owners := make(map[uuid.UUID]uuid.UUID, len(documents))
	for _, document := range documents {
		owners[document.ID] = document.KnowledgeBaseID
	}
	for index, chunk := range chunks {
		knowledgeBaseID, ok := owners[chunk.DocumentID]
		if !ok {
			return fmt.Errorf("chunk %d references missing document %s", index, chunk.DocumentID)
		}
		if chunk.KnowledgeBaseID != knowledgeBaseID {
			return fmt.Errorf("chunk %d knowledge base %s does not match document %s knowledge base %s", index, chunk.KnowledgeBaseID, chunk.DocumentID, knowledgeBaseID)
		}
	}
	return nil
}

// ReindexKeywords recomputes search_vector for every chunk, in primary-key
// order and batches of batchSize, calling progress after each batch with the
// running total. It is the backfill for chunks published before the column
// existed and the repair path after a lexer change; new chunks get their
// vector at publish time and do not need it.
//
// Each batch commits on its own so a long run can be interrupted and resumed
// without holding one transaction open over the whole table.
func (r *ChunkRepository) ReindexKeywords(ctx context.Context, batchSize int, progress func(done int)) (int, error) {
	if batchSize <= 0 {
		batchSize = 200
	}
	var lastID uuid.UUID
	done := 0
	for {
		var rows []struct {
			ID      uuid.UUID
			Content string
		}
		err := r.db.WithContext(ctx).
			Model(&model.DocumentChunk{}).
			Select("id", "content").
			Where("id > ?", lastID).
			Order("id asc").
			Limit(batchSize).
			Find(&rows).Error
		if err != nil {
			return done, err
		}
		if len(rows) == 0 {
			return done, nil
		}
		err = r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			for _, row := range rows {
				vector := model.SearchVector(lexer.TSVector(lexer.Tokenize(row.Content)))
				if err := tx.Model(&model.DocumentChunk{}).
					Where("id = ?", row.ID).
					UpdateColumn("search_vector", vector).Error; err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return done, err
		}
		done += len(rows)
		lastID = rows[len(rows)-1].ID
		if progress != nil {
			progress(done)
		}
	}
}

func (r *ChunkRepository) ListByDocument(ctx context.Context, documentID uuid.UUID) ([]model.DocumentChunk, error) {
	var chunks []model.DocumentChunk
	err := r.db.WithContext(ctx).
		Where("document_id = ?", documentID).
		Order("chunk_index asc").
		Find(&chunks).Error
	return chunks, err
}

func (r *ChunkRepository) ListByDocumentPaged(ctx context.Context, documentID uuid.UUID, chunkID *uuid.UUID, query string, page, pageSize int) ([]model.DocumentChunk, int64, error) {
	page, pageSize = normalizePage(page, pageSize)
	base := r.db.WithContext(ctx).
		Model(&model.DocumentChunk{}).
		Where("document_id = ?", documentID)
	if chunkID != nil {
		base = base.Where("id = ?", *chunkID)
	}
	if strings.TrimSpace(query) != "" {
		like := "%" + strings.ToLower(strings.TrimSpace(query)) + "%"
		base = base.Where("LOWER(content) LIKE ?", like)
	}

	var total int64
	if err := base.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var chunks []model.DocumentChunk
	err := base.
		Select("id, document_id, knowledge_base_id, chunk_index, content, token_count, page_number, metadata, created_at").
		Order("chunk_index asc").
		Limit(pageSize).
		Offset((page - 1) * pageSize).
		Find(&chunks).Error
	return chunks, total, err
}

// minHNSWEfSearch is the floor for hnsw.ef_search. An HNSW scan returns at
// most ef_search candidates, so the setting must be at least the requested
// limit or the query silently returns fewer rows than asked for; 40 is
// pgvector's default and keeps small limits from under-searching the graph.
const minHNSWEfSearch = 40

func (r *ChunkRepository) SearchByVector(ctx context.Context, kbID uuid.UUID, vector []float32, limit int) ([]SearchResult, error) {
	if limit <= 0 {
		limit = 30
	}

	db := r.db.WithContext(ctx)
	if db.Dialector.Name() != "postgres" {
		return searchByVector(db, kbID, vector, limit)
	}

	// SET LOCAL only lives for the enclosing transaction, which is exactly the
	// scope wanted: the setting must not leak into the pooled connection.
	var results []SearchResult
	err := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(fmt.Sprintf("SET LOCAL hnsw.ef_search = %d", max(minHNSWEfSearch, limit))).Error; err != nil {
			return err
		}
		var err error
		results, err = searchByVector(tx, kbID, vector, limit)
		return err
	})
	return results, err
}

func searchByVector(db *gorm.DB, kbID uuid.UUID, vector []float32, limit int) ([]SearchResult, error) {
	var results []SearchResult
	err := publishedChunks(db, kbID).
		Select(`
			document_chunks.id AS chunk_id,
			document_chunks.document_id AS document_id,
			documents.filename AS filename,
			document_chunks.content AS content,
			document_chunks.page_number AS page_number,
			1 - (document_chunks.embedding <=> ?) AS vector_score
		`, pgvector.NewVector(vector)).
		// GORM's Order ignores a bare clause.Expr; it must be wrapped in
		// clause.OrderBy or the query silently loses its ORDER BY.
		Order(clause.OrderBy{Expression: clause.Expr{SQL: "document_chunks.embedding <=> ?", Vars: []any{pgvector.NewVector(vector)}}}).
		Limit(limit).
		Scan(&results).Error
	return results, err
}

// SearchByKeyword returns the published chunks whose search_vector matches any
// lexeme of query, best ts_rank_cd first. The query is tokenized with the same
// lexer that indexed the chunks. A query with no lexemes (punctuation only)
// matches nothing rather than erroring. KeywordScore is ts_rank_cd with
// normalization 32, i.e. rank/(rank+1), so it lies in [0, 1); VectorScore is
// left at zero because no vector distance was computed here.
func (r *ChunkRepository) SearchByKeyword(ctx context.Context, kbID uuid.UUID, query string, limit int) ([]SearchResult, error) {
	if limit <= 0 {
		limit = 30
	}
	tsquery := lexer.TSQuery(lexer.Tokenize(query))
	if tsquery == "" {
		return []SearchResult{}, nil
	}

	var results []SearchResult
	err := publishedChunks(r.db.WithContext(ctx), kbID).
		Select(`
			document_chunks.id AS chunk_id,
			document_chunks.document_id AS document_id,
			documents.filename AS filename,
			document_chunks.content AS content,
			document_chunks.page_number AS page_number,
			0 AS vector_score,
			ts_rank_cd(document_chunks.search_vector, ?::tsquery, 32) AS keyword_score
		`, tsquery).
		Where("document_chunks.search_vector @@ ?::tsquery", tsquery).
		Order(clause.OrderBy{Expression: clause.Expr{SQL: "keyword_score DESC, document_chunks.id ASC"}}).
		Limit(limit).
		Scan(&results).Error
	return results, err
}

// publishedChunks is the shared scope for retrieval: chunks of the knowledge
// base whose document is not soft-deleted. It deliberately does not look at
// documents.status, so the previous snapshot stays searchable while a document
// is being reprocessed.
func publishedChunks(db *gorm.DB, kbID uuid.UUID) *gorm.DB {
	return db.
		Table("document_chunks").
		Joins("JOIN documents ON documents.id = document_chunks.document_id").
		Where("document_chunks.knowledge_base_id = ?", kbID).
		Where("documents.knowledge_base_id = ?", kbID).
		Where("documents.deleted_at IS NULL")
}
