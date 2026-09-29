package storage

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestMinIOStorageIntegration(t *testing.T) {
	endpoint := os.Getenv("RAG_TEST_MINIO_ENDPOINT")
	accessKey := os.Getenv("RAG_TEST_MINIO_ACCESS_KEY")
	secretKey := os.Getenv("RAG_TEST_MINIO_SECRET_KEY")
	if endpoint == "" || accessKey == "" || secretKey == "" {
		t.Skip("RAG_TEST_MINIO_ENDPOINT, RAG_TEST_MINIO_ACCESS_KEY, and RAG_TEST_MINIO_SECRET_KEY are required")
	}
	bucket := os.Getenv("RAG_TEST_MINIO_BUCKET")
	if bucket == "" {
		bucket = "rag-documents"
	}

	fileStorage, err := NewMinIOStorage(MinIOConfig{
		Endpoint:  endpoint,
		AccessKey: accessKey,
		SecretKey: secretKey,
		Bucket:    bucket,
	})
	if err != nil {
		t.Fatalf("create MinIO storage: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := fileStorage.EnsureReady(ctx); err != nil {
		t.Fatalf("ensure MinIO storage ready: %v", err)
	}

	content := []byte("MinIO integration verification")
	location := fileStorage.NewKnowledgeBaseFileLocation(uuid.New(), "验证文档.txt")
	if err := fileStorage.SaveKnowledgeBaseFile(ctx, location, multipartFileHeader(t, "验证文档.txt", content)); err != nil {
		t.Fatalf("save MinIO object: %v", err)
	}
	if !strings.HasPrefix(location, minIOScheme+bucket+"/") {
		t.Fatalf("unexpected MinIO location %q", location)
	}
	t.Cleanup(func() { _ = fileStorage.Delete(context.Background(), location) })

	info, err := fileStorage.Stat(ctx, location)
	if err != nil || info.Size != int64(len(content)) {
		t.Fatalf("stat MinIO object: info=%#v err=%v", info, err)
	}
	read, err := fileStorage.Read(ctx, location)
	if err != nil || !bytes.Equal(read, content) {
		t.Fatalf("read MinIO object: content=%q err=%v", read, err)
	}
	path, cleanup, err := fileStorage.Materialize(ctx, location)
	if err != nil {
		t.Fatalf("materialize MinIO object: %v", err)
	}
	materialized, err := os.ReadFile(path)
	cleanup()
	if err != nil || !bytes.Equal(materialized, content) {
		t.Fatalf("read materialized object: content=%q err=%v", materialized, err)
	}
	if err := fileStorage.Delete(ctx, location); err != nil {
		t.Fatalf("delete MinIO object: %v", err)
	}
	if _, err := fileStorage.Stat(ctx, location); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected deleted object to be missing, got %v", err)
	}

	t.Run("text_reader_roundtrip", func(t *testing.T) {
		text := "# 文本导入\n星桥项目日备份保留35天。\n"
		location := fileStorage.NewKnowledgeBaseFileLocation(uuid.New(), "文本导入.md")
		t.Cleanup(func() { _ = fileStorage.Delete(context.Background(), location) })
		if err := fileStorage.SaveKnowledgeBaseObject(ctx, location, strings.NewReader(text), int64(len(text))); err != nil {
			t.Fatalf("save Reader to MinIO: %v", err)
		}
		info, err := fileStorage.Stat(ctx, location)
		if err != nil || info.Size != int64(len(text)) {
			t.Fatalf("Reader byte size: info=%#v err=%v", info, err)
		}
		read, err := fileStorage.Read(ctx, location)
		if err != nil || string(read) != text {
			t.Fatalf("Reader roundtrip: content=%q err=%v", read, err)
		}
		if err := fileStorage.Delete(ctx, location); err != nil {
			t.Fatal(err)
		}
		if _, err := fileStorage.Stat(ctx, location); !errors.Is(err, ErrNotFound) {
			t.Fatalf("deleted Reader object: %v", err)
		}
	})
}

func multipartFileHeader(t *testing.T, filename string, content []byte) *multipart.FileHeader {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create multipart file: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write multipart file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	request := httptest.NewRequest("POST", "/upload", body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	if err := request.ParseMultipartForm(int64(body.Len())); err != nil {
		t.Fatalf("parse multipart form: %v", err)
	}
	t.Cleanup(func() { _ = request.MultipartForm.RemoveAll() })
	files := request.MultipartForm.File["file"]
	if len(files) != 1 {
		t.Fatalf("expected one multipart file, got %d", len(files))
	}
	return files[0]
}
