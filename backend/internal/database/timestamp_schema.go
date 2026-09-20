package database

import (
	"context"
	"fmt"
	"strings"

	"gorm.io/gorm"

	"kbchat/backend/internal/model"
)

// Existing tables are not altered by AutoMigrate. Refuse to run against the old
// timestamp schema rather than silently discarding offsets in bound Go times.
func validateTimestampSchema(ctx context.Context, db *gorm.DB) error {
	if db.Dialector.Name() != "postgres" {
		return nil
	}
	tables := make([]string, 0)
	for _, item := range timestampSchemaModels() {
		statement := &gorm.Statement{DB: db}
		if err := statement.Parse(item); err != nil {
			return err
		}
		tables = append(tables, statement.Schema.Table)
	}
	var columns []string
	if err := db.WithContext(ctx).Raw(
		"SELECT table_name || '.' || column_name FROM information_schema.columns "+
			"WHERE table_schema = current_schema() AND table_name IN ? "+
			"AND data_type = 'timestamp without time zone' ORDER BY table_name, ordinal_position",
		tables,
	).Scan(&columns).Error; err != nil {
		return fmt.Errorf("validate timestamp schema: %w", err)
	}
	if len(columns) != 0 {
		return fmt.Errorf(
			"database schema incompatible: %s must use timestamptz; apply migration 023 (migrations/023_timestamps_with_time_zone.sql)",
			strings.Join(columns, ", "),
		)
	}
	return nil
}

func timestampSchemaModels() []any {
	return append(autoMigrateModels(),
		&model.KnowledgeBaseTag{},
		&model.KnowledgeBaseTagBinding{},
		&model.KnowledgeBaseWorkspacePreference{},
		&model.UserAvatar{},
	)
}
