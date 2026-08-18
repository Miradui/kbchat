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
)

type LocalStorage struct {
	root string
}

func NewLocalStorage(root string) *LocalStorage {
	return &LocalStorage{root: root}
}

func (s *LocalStorage) SaveKnowledgeBaseFile(ctx context.Context, kbID uuid.UUID, file *multipart.FileHeader) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(s.root, kbID.String()), 0755); err != nil {
		return "", err
	}

	key := knowledgeBaseObjectKey(kbID, file.Filename)
	target := filepath.Join(s.root, filepath.FromSlash(key))

	src, err := file.Open()
	if err != nil {
		return "", err
	}
	defer src.Close()

	dst, err := os.Create(target)
	if err != nil {
		return "", err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return "", err
	}

	return target, nil
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

func localStorageError(err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	}
	return err
}
