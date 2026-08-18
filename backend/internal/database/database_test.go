package database

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"rag/backend/internal/model"
)

func TestAutoMigrateModelsIncludeOperationalTables(t *testing.T) {
	required := map[reflect.Type]bool{
		reflect.TypeOf(&model.Activity{}):          false,
		reflect.TypeOf(&model.StorageCleanupJob{}): false,
	}
	for _, item := range autoMigrateModels() {
		if _, ok := required[reflect.TypeOf(item)]; ok {
			required[reflect.TypeOf(item)] = true
		}
	}
	for modelType, found := range required {
		if !found {
			t.Fatalf("auto-migrate models must include %v", modelType)
		}
	}
}

func TestValidateSchemaRejectsMissingChatFeedbackColumns(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file::memory:?cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.Exec(`CREATE TABLE chat_messages (id TEXT PRIMARY KEY)`).Error; err != nil {
		t.Fatalf("create chat_messages: %v", err)
	}

	err = validateSchema(context.Background(), db)
	if err == nil {
		t.Fatal("expected missing feedback columns to fail validation")
	}
	for _, fragment := range []string{"chat_messages", "feedback_rating", "feedback_updated_at", "migration 014"} {
		if !strings.Contains(err.Error(), fragment) {
			t.Fatalf("expected error %q to contain %q", err, fragment)
		}
	}
}

func TestValidateSchemaAcceptsChatFeedbackColumns(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:validate-complete?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.Exec(`CREATE TABLE chat_messages (
		id TEXT PRIMARY KEY,
		feedback_rating TEXT,
		feedback_updated_at DATETIME
	)`).Error; err != nil {
		t.Fatalf("create chat_messages: %v", err)
	}
	if err := db.AutoMigrate(&model.StorageCleanupJob{}); err != nil {
		t.Fatalf("migrate storage cleanup jobs: %v", err)
	}

	if err := validateSchema(context.Background(), db); err != nil {
		t.Fatalf("validate complete schema: %v", err)
	}
}

func TestValidateSchemaRejectsIncompleteStorageCleanupTable(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:validate-cleanup?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.Exec(`CREATE TABLE chat_messages (
		id TEXT PRIMARY KEY,
		feedback_rating TEXT,
		feedback_updated_at DATETIME
	)`).Error; err != nil {
		t.Fatalf("create chat_messages: %v", err)
	}
	if err := db.Exec(`CREATE TABLE storage_cleanup_jobs (id TEXT PRIMARY KEY, storage_path TEXT)`).Error; err != nil {
		t.Fatalf("create incomplete cleanup table: %v", err)
	}

	err = validateSchema(context.Background(), db)
	if err == nil || !strings.Contains(err.Error(), "migration 015") || !strings.Contains(err.Error(), "lease_token") {
		t.Fatalf("expected migration 015 compatibility error, got %v", err)
	}
}
