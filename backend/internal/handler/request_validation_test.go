package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"rag/backend/internal/middleware"
)

func TestBatchHandlersReturnReadableInvalidBodyError(t *testing.T) {
	tests := []struct {
		name string
		run  func(*gin.Context)
	}{
		{name: "document delete", run: func(c *gin.Context) { NewDocumentHandler(nil, 50).BatchDelete(c) }},
		{name: "document restore", run: func(c *gin.Context) { NewDocumentHandler(nil, 50).BatchRestore(c) }},
		{name: "document reprocess", run: func(c *gin.Context) { NewDocumentHandler(nil, 50).BatchReprocess(c) }},
		{name: "category reorder", run: func(c *gin.Context) { NewKnowledgeBaseCategoryHandler(nil).Reorder(c) }},
		{name: "knowledge base favorite", run: func(c *gin.Context) { NewKnowledgeBaseHandler(nil).BatchFavorite(c) }},
		{name: "knowledge base move", run: func(c *gin.Context) { NewKnowledgeBaseHandler(nil).BatchMoveCategory(c) }},
		{name: "knowledge base delete", run: func(c *gin.Context) { NewKnowledgeBaseHandler(nil).BatchDelete(c) }},
		{name: "knowledge base restore", run: func(c *gin.Context) { NewKnowledgeBaseHandler(nil).BatchRestore(c) }},
		{name: "knowledge base permissions", run: func(c *gin.Context) { NewKnowledgeBaseHandler(nil).UpdatePermissions(c) }},
	}

	gin.SetMode(gin.TestMode)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(recorder)
			context.Request = httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{"))
			context.Request.Header.Set("Content-Type", "application/json")
			context.Set(middleware.CurrentUserIDKey, uuid.New())
			context.Params = gin.Params{{Key: "id", Value: uuid.NewString()}}

			tt.run(context)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, recorder.Code, recorder.Body.String())
			}
			var response struct {
				Details map[string]string `json:"details"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if got := response.Details["body"]; got != "请求参数不合法" {
				t.Fatalf("expected readable invalid body detail, got %q", got)
			}
		})
	}
}
