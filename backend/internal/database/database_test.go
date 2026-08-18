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

func TestAutoMigrateModelsIncludeActivity(t *testing.T) {
	activityType := reflect.TypeOf(&model.Activity{})
	for _, item := range autoMigrateModels() {
		if reflect.TypeOf(item) == activityType {
			return
		}
	}

	t.Fatal("auto-migrate models must include activities")
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

	if err := validateSchema(context.Background(), db); err != nil {
		t.Fatalf("validate complete schema: %v", err)
	}
}
