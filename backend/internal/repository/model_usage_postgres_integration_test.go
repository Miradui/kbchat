package repository

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/model"
	"testing"
	"time"
)

func TestPostgresModelUsageAllGroups(t *testing.T) {
	db, _ := newPostgresConcurrencyTestDBs(t)
	if err := db.Exec("ALTER TABLE users ADD COLUMN display_name TEXT").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.ModelUsageRecord{}); err != nil {
		t.Fatal(err)
	}
	owner, kb := uuid.New(), uuid.New()
	insertPostgresRecycleFixture(t, db, owner, kb)
	total := 13
	repo := NewModelUsageRepository(db)
	for _, purpose := range []string{"intent", "answer", "title", "evaluation"} {
		if err := repo.Create(context.Background(), &model.ModelUsageRecord{UserID: owner, KnowledgeBaseID: kb, Purpose: purpose, Model: "requested-model", TotalTokens: &total}); err != nil {
			t.Fatal(err)
		}
	}
	for _, group := range []string{"day", "model", "purpose", "knowledgeBase", "user"} {
		t.Run(group, func(t *testing.T) {
			rows, err := repo.Aggregate(context.Background(), UsageScope{AllKnowledgeBases: true}, time.Now().Add(-time.Hour), time.Now().Add(time.Hour), group)
			if err != nil {
				t.Fatal(err)
			}
			var calls, tokens int64
			for _, row := range rows {
				calls += row.Calls
				tokens += row.TotalTokens
			}
			if calls != 4 || tokens != 52 {
				t.Fatalf("calls=%d tokens=%d rows=%v", calls, tokens, rows)
			}
		})
	}
}
