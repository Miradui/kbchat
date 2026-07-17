package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"rag/backend/internal/middleware"
)

func TestDocumentUploadHandlersLimitBodyBeforeParsingMultipart(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		global  bool
		handler func(*DocumentHandler, *gin.Context)
	}{
		{
			name:    "knowledge base upload",
			path:    "/api/v1/knowledge-bases/placeholder/documents",
			handler: func(handler *DocumentHandler, c *gin.Context) { handler.Upload(c) },
		},
		{
			name:    "global upload",
			path:    "/api/v1/documents",
			global:  true,
			handler: func(handler *DocumentHandler, c *gin.Context) { handler.UploadGlobal(c) },
		},
	}

	gin.SetMode(gin.TestMode)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request, counter := oversizedMultipartRequest(t, tt.path, tt.global)
			recorder := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(recorder)
			context.Request = request
			context.Set(middleware.CurrentUserIDKey, uuid.New())
			context.Params = gin.Params{{Key: "id", Value: uuid.NewString()}}

			handler := NewDocumentHandler(nil, 1)
			tt.handler(handler, context)
			if request.MultipartForm != nil {
				t.Cleanup(func() { _ = request.MultipartForm.RemoveAll() })
			}

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, recorder.Code, recorder.Body.String())
			}
			var response struct {
				Code    string            `json:"code"`
				Details map[string]string `json:"details"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if response.Code != "VALIDATION_ERROR" || response.Details["file"] != "file size exceeds limit" {
				t.Fatalf("unexpected response: %#v", response)
			}
			const maxRead = 2*1024*1024 + 1
			if counter.read > maxRead {
				t.Fatalf("expected request reading to stop by %d bytes, read %d", maxRead, counter.read)
			}
		})
	}
}

type countingReader struct {
	reader io.Reader
	read   int
}

func (r *countingReader) Read(buffer []byte) (int, error) {
	n, err := r.reader.Read(buffer)
	r.read += n
	return n, err
}

func oversizedMultipartRequest(t *testing.T, path string, includeKnowledgeBaseID bool) (*http.Request, *countingReader) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if includeKnowledgeBaseID {
		if err := writer.WriteField("knowledgeBaseId", uuid.NewString()); err != nil {
			t.Fatalf("write knowledge base ID: %v", err)
		}
	}
	part, err := writer.CreateFormFile("file", "oversized.txt")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := io.Copy(part, strings.NewReader(strings.Repeat("x", 2*1024*1024))); err != nil {
		t.Fatalf("write oversized file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	counter := &countingReader{reader: bytes.NewReader(body.Bytes())}
	request := httptest.NewRequest(http.MethodPost, path, counter)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request, counter
}
