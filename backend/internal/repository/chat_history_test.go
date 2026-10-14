package repository

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"kbchat/backend/internal/model"
)

func historyFixture(t *testing.T, db *gorm.DB, count int) (uuid.UUID, []model.ChatMessage) {
	t.Helper()
	user := model.User{Username: uuid.NewString(), PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	kb := model.KnowledgeBase{Name: "history", OwnerID: user.ID}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}
	session := model.ChatSession{UserID: user.ID, KnowledgeBaseID: kb.ID}
	if err := db.Create(&session).Error; err != nil {
		t.Fatal(err)
	}
	items := make([]model.ChatMessage, count)
	for i := range items {
		role := "assistant"
		if i%4 == 0 {
			role = "user"
		}
		items[i] = model.ChatMessage{ID: uuid.MustParse(fmt.Sprintf("00000000-0000-0000-0000-%012d", i+1)), SessionID: session.ID, Role: role, Content: fmt.Sprint(i), CreatedAt: time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)}
	}
	if count > 0 {
		if err := db.Create(&items).Error; err != nil {
			t.Fatal(err)
		}
	}
	return session.ID, items
}

func TestChatHistoryPagesKeepTurnsAndTimestampTiesTogether(t *testing.T) {
	db := newChatRepositoryTestDB(t)
	sid, items := historyFixture(t, db, 24)
	r := NewChatRepository(db)
	ctx := context.Background()
	query := ChatHistoryQuery{Limit: 5}
	seen := map[uuid.UUID]bool{}
	for pageIndex := 0; pageIndex < 3; pageIndex++ {
		page, err := r.ListMessagePage(ctx, sid, query)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != 8 || page.Items[0].Role != "user" || page.HasMore != (pageIndex < 2) {
			t.Fatalf("bad page: %+v", page)
		}
		for i, item := range page.Items {
			if seen[item.ID] || item.ID != items[16-pageIndex*8+i].ID {
				t.Fatalf("duplicate or out of order: %s", item.ID)
			}
			seen[item.ID] = true
		}
		query.Before, query.Revision = page.NextCursor, page.Revision
	}
	if len(seen) != len(items) {
		t.Fatalf("missing messages: %d", len(seen))
	}
}

func TestChatHistoryRefreshAndConcurrentTailChanges(t *testing.T) {
	db := newChatRepositoryTestDB(t)
	sid, _ := historyFixture(t, db, 12)
	r := NewChatRepository(db)
	ctx := context.Background()
	page, err := r.ListMessagePage(ctx, sid, ChatHistoryQuery{Limit: 4})
	if err != nil {
		t.Fatal(err)
	}
	appended := model.ChatMessage{SessionID: sid, Role: "assistant", Content: "new version", CreatedAt: time.Now()}
	if err := db.Create(&appended).Error; err != nil {
		t.Fatal(err)
	}
	_, err = r.ListMessagePage(ctx, sid, ChatHistoryQuery{Limit: 4, Before: page.NextCursor, Revision: page.Revision})
	if !errors.Is(err, ErrChatMessageChanged) {
		t.Fatalf("stale history revision accepted: %v", err)
	}
	refreshed, err := r.ListMessagePage(ctx, sid, ChatHistoryQuery{Limit: 4, Since: page.NextCursor})
	if err != nil || len(refreshed.Items) != 5 || refreshed.Items[4].ID != appended.ID || !refreshed.HasMore {
		t.Fatalf("refresh: %+v, %v", refreshed, err)
	}
	if err := db.Delete(&model.ChatMessage{}, "id = ?", page.NextCursor.ID).Error; err != nil {
		t.Fatal(err)
	}
	_, err = r.ListMessagePage(ctx, sid, ChatHistoryQuery{Limit: 4, Since: page.NextCursor})
	if !errors.Is(err, ErrChatMessageChanged) {
		t.Fatalf("deleted boundary accepted: %v", err)
	}
}

func TestChatHistoryEmptyAndLegacyOrphanAnswers(t *testing.T) {
	db := newChatRepositoryTestDB(t)
	sid, _ := historyFixture(t, db, 0)
	r := NewChatRepository(db)
	page, err := r.ListMessagePage(context.Background(), sid, ChatHistoryQuery{Limit: 2})
	if err != nil || page.Items == nil || len(page.Items) != 0 || page.HasMore {
		t.Fatalf("empty: %+v %v", page, err)
	}
	for i := 0; i < 3; i++ {
		if err := db.Create(&model.ChatMessage{SessionID: sid, Role: "assistant", Content: "legacy", CreatedAt: time.Now().Add(time.Duration(i) * time.Second)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	page, err = r.ListMessagePage(context.Background(), sid, ChatHistoryQuery{Limit: 2})
	if err != nil || len(page.Items) != 3 || page.HasMore {
		t.Fatalf("orphan group: %+v %v", page, err)
	}
}

func TestChatHistoryAroundAndForwardPagesPreserveVersionsWithoutReadingTheTail(t *testing.T) {
	db := newChatRepositoryTestDB(t)
	sid, items := historyFixture(t, db, 1000)
	r := NewChatRepository(db)
	ctx := context.Background()
	page, err := r.ListMessagePage(ctx, sid, ChatHistoryQuery{Limit: 5, Around: &items[401].ID})
	if err != nil || len(page.Items) != 8 || page.Items[0].ID != items[396].ID || page.Items[7].ID != items[403].ID || !page.HasMore || !page.HasNewer {
		t.Fatalf("bounded context: %+v %v", page, err)
	}
	forward, err := r.ListMessagePage(ctx, sid, ChatHistoryQuery{Limit: 5, After: page.NewerCursor, Revision: page.Revision})
	if err != nil || len(forward.Items) != 8 || forward.Items[0].ID != items[404].ID || forward.Items[7].ID != items[411].ID || !forward.HasNewer {
		t.Fatalf("next context: %+v %v", forward, err)
	}
	backward, err := r.ListMessagePage(ctx, sid, ChatHistoryQuery{Limit: 5, Before: page.NextCursor, Revision: page.Revision})
	if err != nil || len(backward.Items) != 8 || backward.Items[7].ID != items[395].ID {
		t.Fatalf("previous context: %+v %v", backward, err)
	}
	for _, target := range []int{0, 1, 500, 997, 999} {
		window, err := r.ListMessagePage(ctx, sid, ChatHistoryQuery{Limit: 1, Around: &items[target].ID})
		if err != nil || len(window.Items) != 4 || window.Items[0].ID != items[target/4*4].ID || window.HasNewer != (target < 996) || window.HasMore != (target >= 4) {
			t.Fatalf("complete turn around %d: %+v %v", target, window, err)
		}
	}
	missing := uuid.New()
	_, err = r.ListMessagePage(ctx, sid, ChatHistoryQuery{Limit: 5, Around: &missing})
	if !errors.Is(err, ErrChatMessageNotFound) {
		t.Fatalf("missing target: %v", err)
	}
	if err := db.Create(&model.ChatMessage{SessionID: sid, Role: "assistant", Content: "new version", CreatedAt: time.Now().Add(time.Hour)}).Error; err != nil {
		t.Fatal(err)
	}
	_, err = r.ListMessagePage(ctx, sid, ChatHistoryQuery{Limit: 5, After: page.NewerCursor, Revision: page.Revision})
	if !errors.Is(err, ErrChatMessageChanged) {
		t.Fatalf("stale forward page: %v", err)
	}
}
