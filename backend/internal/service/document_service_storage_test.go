package service

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/model"
	"kbchat/backend/internal/storage"
)

func TestDocumentDownloadAndPreviewUseConfiguredStorage(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "remote-storage-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "remote-storage-kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.md", "completed")
	location := "minio://rag-documents/" + kb.ID.String() + "/object.md"
	remote := &memoryDocumentStorage{objects: map[string][]byte{location: []byte("# Remote\ncontent")}}
	services.documents.storage = remote
	if err := services.db.Model(&model.Document{}).Where("id = ?", document.ID).Update("storage_path", location).Error; err != nil {
		t.Fatalf("update storage path: %v", err)
	}

	download, err := services.documents.Download(ctx, owner.ID, document.ID)
	if err != nil {
		t.Fatalf("download remote object: %v", err)
	}
	defer download.Reader.Close()
	content, err := io.ReadAll(download.Reader)
	if err != nil {
		t.Fatalf("read remote download: %v", err)
	}
	if string(content) != "# Remote\ncontent" || download.Size != int64(len(content)) {
		t.Fatalf("unexpected remote download: size=%d content=%q", download.Size, content)
	}

	preview, err := services.documents.Preview(ctx, owner.ID, document.ID)
	if err != nil {
		t.Fatalf("preview remote object: %v", err)
	}
	if preview.Content != "# Remote\ncontent" || preview.Kind != "text" {
		t.Fatalf("unexpected remote preview: %#v", preview)
	}
}

type memoryDocumentStorage struct {
	objects map[string][]byte
}

func (s *memoryDocumentStorage) NewKnowledgeBaseFileLocation(uuid.UUID, string) string {
	return ""
}

func (s *memoryDocumentStorage) SaveKnowledgeBaseFile(context.Context, string, *multipart.FileHeader) error {
	return fmt.Errorf("not implemented")
}

func (s *memoryDocumentStorage) Delete(_ context.Context, location string) error {
	delete(s.objects, location)
	return nil
}

func (s *memoryDocumentStorage) Open(_ context.Context, location string) (io.ReadCloser, storage.ObjectInfo, error) {
	content, ok := s.objects[location]
	if !ok {
		return nil, storage.ObjectInfo{}, storage.ErrNotFound
	}
	return io.NopCloser(bytes.NewReader(content)), storage.ObjectInfo{Size: int64(len(content))}, nil
}

func (s *memoryDocumentStorage) Read(_ context.Context, location string) ([]byte, error) {
	content, ok := s.objects[location]
	if !ok {
		return nil, storage.ErrNotFound
	}
	return bytes.Clone(content), nil
}

func (s *memoryDocumentStorage) Stat(_ context.Context, location string) (storage.ObjectInfo, error) {
	content, ok := s.objects[location]
	if !ok {
		return storage.ObjectInfo{}, storage.ErrNotFound
	}
	return storage.ObjectInfo{Size: int64(len(content))}, nil
}

func (s *memoryDocumentStorage) Materialize(_ context.Context, location string) (string, func(), error) {
	content, ok := s.objects[location]
	if !ok {
		return "", nil, storage.ErrNotFound
	}
	temporary, err := os.CreateTemp("", "document-storage-test-*")
	if err != nil {
		return "", nil, err
	}
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		_ = os.Remove(temporary.Name())
		return "", nil, err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporary.Name())
		return "", nil, err
	}
	return temporary.Name(), func() { _ = os.Remove(temporary.Name()) }, nil
}

func (s *memoryDocumentStorage) SaveKnowledgeBaseObject(context.Context, string, io.Reader, int64) error {
	return fmt.Errorf("not implemented")
}
