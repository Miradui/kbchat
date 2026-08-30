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
