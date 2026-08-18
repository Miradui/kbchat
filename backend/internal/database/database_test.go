package database

import (
	"reflect"
	"testing"

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
