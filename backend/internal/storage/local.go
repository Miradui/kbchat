package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"

	"github.com/google/uuid"

	"kbchat/backend/internal/observability"
)

type LocalStorage struct {
	root string
}

func NewLocalStorage(root string) *LocalStorage {
	return &LocalStorage{root: root}
}

func (s *LocalStorage) NewKnowledgeBaseFileLocation(kbID uuid.UUID, filename string) string {
	key := knowledgeBaseObjectKey(kbID, filename)
	return filepath.Join(s.root, filepath.FromSlash(key))
}

func (s *LocalStorage) SaveKnowledgeBaseFile(ctx context.Context, target string, file *multipart.FileHeader) error {
	src, err := file.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	return s.SaveKnowledgeBaseObject(ctx, target, src, file.Size)
}

func (s *LocalStorage) SaveKnowledgeBaseObject(ctx context.Context, target string, reader io.Reader, size int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if size < 0 {
		return fmt.Errorf("invalid object size")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	dst, err := os.Create(target)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(dst, io.LimitReader(contextReader{ctx: ctx, reader: reader}, size+1))
	closeErr := dst.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if n != size {
		return fmt.Errorf("object size mismatch: got %d, want %d", n, size)
	}
	return ctx.Err()
}

func (s *LocalStorage) Delete(ctx context.Context, path string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *LocalStorage) Open(ctx context.Context, path string) (io.ReadCloser, ObjectInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, ObjectInfo{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, ObjectInfo{}, localStorageError(err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, ObjectInfo{}, err
	}
	return file, ObjectInfo{Size: info.Size(), LastModified: info.ModTime()}, nil
}

func (s *LocalStorage) Read(ctx context.Context, path string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	content, err := os.ReadFile(path)
	return content, localStorageError(err)
}

func (s *LocalStorage) Stat(ctx context.Context, path string) (ObjectInfo, error) {
	if err := ctx.Err(); err != nil {
		return ObjectInfo{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return ObjectInfo{}, localStorageError(err)
	}
	return ObjectInfo{Size: info.Size(), LastModified: info.ModTime()}, nil
}

func (s *LocalStorage) Materialize(ctx context.Context, path string) (string, func(), error) {
	if _, err := s.Stat(ctx, path); err != nil {
		return "", nil, err
	}
	return path, func() {}, nil
}

// CheckHealth verifies the upload root exists and is a directory. A full disk is
// not detectable this cheaply, but a root that was never created or was mounted
// away is the failure that actually silently breaks uploads.
func (s *LocalStorage) CheckHealth(_ context.Context) error {
	info, err := os.Stat(s.root)
	if err != nil {
		return fmt.Errorf("stat upload directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("upload path is not a directory: %w", observability.ErrNotFound)
	}
	return nil
}

func localStorageError(err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	}
	return err
}
