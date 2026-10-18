package repository

import (
	"context"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"kbchat/backend/internal/model"
)

type documentSearchScopeKey struct{}

// Only retrieval installs a validated scope; every recall path carries the same context.
func WithDocumentSearchScope(ctx context.Context, ids []uuid.UUID) context.Context {
	return context.WithValue(ctx, documentSearchScopeKey{}, append([]uuid.UUID(nil), ids...))
}
func documentSearchScope(ctx context.Context) []uuid.UUID {
	ids, _ := ctx.Value(documentSearchScopeKey{}).([]uuid.UUID)
	return ids
}
func applyDocumentSearchScope(db *gorm.DB) *gorm.DB {
	if ids := documentSearchScope(db.Statement.Context); len(ids) > 0 {
		return db.Where("documents.id IN ?", ids)
	}
	return db.Where(documentVersionSearchCondition)
}

// Services must authorize every base before using this repository lookup.
func findScopeDocuments(db *gorm.DB, ids, baseIDs []uuid.UUID) ([]model.Document, error) {
	var documents []model.Document
	err := db.Select("id", "knowledge_base_id", "filename").Where("id IN ? AND knowledge_base_id IN ?", ids, baseIDs).Find(&documents).Error
	return documents, err
}
func (r *ChatRepository) FindScopeDocuments(ctx context.Context, ids, baseIDs []uuid.UUID) ([]model.Document, error) {
	return findScopeDocuments(r.db.WithContext(ctx), ids, baseIDs)
}
func (r *ChunkRepository) FindScopeDocuments(ctx context.Context, ids, baseIDs []uuid.UUID) ([]model.Document, error) {
	return findScopeDocuments(r.db.WithContext(ctx), ids, baseIDs)
}
