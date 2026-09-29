package repository

import (
	"context"
	"fmt"

	"gorm.io/gorm"
)

// SystemRepository exposes database-level health for diagnostics.
//
// It exists so the diagnostics service can stay on the repository side of the
// layering rule instead of holding a *gorm.DB to reach the underlying pool.
type SystemRepository struct {
	db *gorm.DB
}

func NewSystemRepository(db *gorm.DB) *SystemRepository {
	return &SystemRepository{db: db}
}

// Ping checks a connection can be obtained and answers.
//
// PingContext is used rather than a SELECT 1 because it exercises the pool's own
// liveness handling, including replacing a connection the server closed. The
// returned error is wrapped without adding detail: it already contains the DSN
// host in many drivers, so callers must classify it rather than surface it.
func (r *SystemRepository) Ping(ctx context.Context) error {
	sqlDB, err := r.db.DB()
	if err != nil {
		return fmt.Errorf("resolve database handle: %w", err)
	}
	if err := sqlDB.PingContext(ctx); err != nil {
		return fmt.Errorf("ping database: %w", err)
	}
	return nil
}

// EmbeddingColumnDimension reads the actual column, including a non-public test
// schema resolved by search_path. Zero means the column could not be identified.
func (r *SystemRepository) EmbeddingColumnDimension(ctx context.Context) (int, error) {
	if r.db.Dialector.Name() != "postgres" {
		return 0, nil
	}
	var result struct{ Dimension int }
	err := r.db.WithContext(ctx).Raw(`SELECT a.atttypmod AS dimension
FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attrelid = to_regclass('document_chunks') AND a.attname = 'embedding'
AND NOT a.attisdropped AND t.typname = 'vector'`).Scan(&result).Error
	return result.Dimension, err
}

func CheckEmbeddingDimension(actual, configured int) error {
	if actual <= 0 || configured <= 0 || actual != configured {
		return fmt.Errorf("embedding dimension mismatch: document_chunks.embedding has %d, EMBEDDING_DIMENSION is %d; migrate the vector column and rebuild HNSW before reembedding (docs/13-deployment.md)", actual, configured)
	}
	return nil
}

func (r *SystemRepository) ValidateEmbeddingDimension(ctx context.Context, configured int) error {
	if r.db.Dialector.Name() != "postgres" {
		return nil
	}
	actual, err := r.EmbeddingColumnDimension(ctx)
	if err != nil {
		return err
	}
	return CheckEmbeddingDimension(actual, configured)
}
