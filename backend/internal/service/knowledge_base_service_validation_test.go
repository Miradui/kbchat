package service

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
)

func TestKnowledgeBaseBatchOperationsReturnReadableEmptySelectionError(t *testing.T) {
	service := &KnowledgeBaseService{}
	tests := []struct {
		name string
		run  func() error
	}{
		{name: "favorite", run: func() error {
			_, err := service.BatchSetFavorite(context.Background(), uuid.New(), dto.KnowledgeBaseBatchFavoriteRequest{})
			return err
		}},
		{name: "move", run: func() error {
			_, err := service.BatchMoveCategory(context.Background(), uuid.New(), dto.KnowledgeBaseBatchMoveCategoryRequest{})
			return err
		}},
		{name: "delete", run: func() error {
			_, err := service.BatchDelete(context.Background(), uuid.New(), dto.KnowledgeBaseBatchRequest{})
			return err
		}},
		{name: "restore", run: func() error {
			_, err := service.BatchRestore(context.Background(), uuid.New(), dto.KnowledgeBaseBatchRequest{})
			return err
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var appErr *apperror.Error
			if err := tt.run(); !errors.As(err, &appErr) {
				t.Fatalf("expected application error, got %v", err)
			}
			if got := appErr.Details["knowledgeBaseIds"]; got != "知识库 ID 不能为空" {
				t.Fatalf("expected readable validation detail, got %q", got)
			}
		})
	}
}
