package storage

import (
	"context"
	"errors"
	"io"
	"mime/multipart"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/config"
)

var ErrNotFound = errors.New("stored object not found")

type ObjectInfo struct {
	Size         int64
	LastModified time.Time
}

type Storage interface {
	NewKnowledgeBaseFileLocation(uuid.UUID, string) string
	SaveKnowledgeBaseFile(context.Context, string, *multipart.FileHeader) error
	SaveKnowledgeBaseObject(context.Context, string, io.Reader, int64) error
	Delete(context.Context, string) error
	Open(context.Context, string) (io.ReadCloser, ObjectInfo, error)
	Read(context.Context, string) ([]byte, error)
	Stat(context.Context, string) (ObjectInfo, error)
	Materialize(context.Context, string) (string, func(), error)
}

type readinessChecker interface {
	EnsureReady(context.Context) error
}

func EnsureReady(ctx context.Context, fileStorage Storage) error {
	if checker, ok := fileStorage.(readinessChecker); ok {
		return checker.EnsureReady(ctx)
	}
	return nil
}

// healthChecker is the read-only counterpart of readinessChecker.
type healthChecker interface {
	CheckHealth(context.Context) error
}

// CheckHealth probes storage without changing it.
//
// EnsureReady is deliberately not reused here: for MinIO it creates the bucket
// and applies a policy, which is correct at boot and wrong behind an HTTP
// handler, where it would let an authenticated GET recreate a bucket an operator
// removed on purpose. Backends without the capability report healthy, matching
// EnsureReady's optional-interface shape.
func CheckHealth(ctx context.Context, fileStorage Storage) error {
	if checker, ok := fileStorage.(healthChecker); ok {
		return checker.CheckHealth(ctx)
	}
	return nil
}

func NewFromConfig(cfg config.Config) (Storage, error) {
	local := NewLocalStorage(cfg.UploadDir)
	if strings.ToLower(strings.TrimSpace(cfg.StorageProvider)) != "minio" {
		if minIOConfigComplete(cfg) {
			remote, err := newMinIOFromConfig(cfg)
			if err != nil {
				return nil, err
			}
			return &RoutedStorage{primary: local, local: local, remote: remote}, nil
		}
		return local, nil
	}
	remote, err := newMinIOFromConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &RoutedStorage{primary: remote, local: local, remote: remote}, nil
}

func newMinIOFromConfig(cfg config.Config) (*MinIOStorage, error) {
	return NewMinIOStorage(MinIOConfig{
		Endpoint:         cfg.MinIOEndpoint,
		AccessKey:        cfg.MinIOAccessKey,
		SecretKey:        cfg.MinIOSecretKey,
		Bucket:           cfg.MinIOBucket,
		Region:           cfg.MinIORegion,
		UseSSL:           cfg.MinIOUseSSL,
		OperationTimeout: cfg.StorageOperationTimeout,
	})
}

func minIOConfigComplete(cfg config.Config) bool {
	return strings.TrimSpace(cfg.MinIOEndpoint) != "" &&
		strings.TrimSpace(cfg.MinIOAccessKey) != "" &&
		strings.TrimSpace(cfg.MinIOSecretKey) != "" &&
		strings.TrimSpace(cfg.MinIOBucket) != ""
}

func knowledgeBaseObjectKey(kbID uuid.UUID, originalFilename string) string {
	ext := strings.ToLower(filepath.Ext(filepath.Base(originalFilename)))
	return kbID.String() + "/" + uuid.NewString() + ext
}

type RoutedStorage struct {
	primary Storage
	local   Storage
	remote  Storage
}

func (s *RoutedStorage) backend(location string) Storage {
	if strings.HasPrefix(location, minIOScheme) {
		return s.remote
	}
	return s.local
}

func (s *RoutedStorage) NewKnowledgeBaseFileLocation(kbID uuid.UUID, filename string) string {
	return s.primary.NewKnowledgeBaseFileLocation(kbID, filename)
}

func (s *RoutedStorage) SaveKnowledgeBaseFile(ctx context.Context, location string, file *multipart.FileHeader) error {
	return s.backend(location).SaveKnowledgeBaseFile(ctx, location, file)
}

func (s *RoutedStorage) SaveKnowledgeBaseObject(ctx context.Context, location string, reader io.Reader, size int64) error {
	return s.backend(location).SaveKnowledgeBaseObject(ctx, location, reader, size)
}

func (s *RoutedStorage) Delete(ctx context.Context, location string) error {
	return s.backend(location).Delete(ctx, location)
}

func (s *RoutedStorage) Open(ctx context.Context, location string) (io.ReadCloser, ObjectInfo, error) {
	return s.backend(location).Open(ctx, location)
}

func (s *RoutedStorage) Read(ctx context.Context, location string) ([]byte, error) {
	return s.backend(location).Read(ctx, location)
}

func (s *RoutedStorage) Stat(ctx context.Context, location string) (ObjectInfo, error) {
	return s.backend(location).Stat(ctx, location)
}

func (s *RoutedStorage) Materialize(ctx context.Context, location string) (string, func(), error) {
	return s.backend(location).Materialize(ctx, location)
}

func (s *RoutedStorage) EnsureReady(ctx context.Context) error {
	if err := EnsureReady(ctx, s.primary); err != nil {
		return err
	}
	if s.remote != nil && s.remote != s.primary {
		return EnsureReady(ctx, s.remote)
	}
	return nil
}

// CheckHealth reports the worst state across the backends this router can serve
// from. A healthy primary is not enough: documents already stored on the other
// backend become unreadable if it is down, so both are probed.
func (s *RoutedStorage) CheckHealth(ctx context.Context) error {
	if err := CheckHealth(ctx, s.primary); err != nil {
		return err
	}
	if s.remote != nil && s.remote != s.primary {
		if err := CheckHealth(ctx, s.remote); err != nil {
			return err
		}
	}
	if s.local != nil && s.local != s.primary && s.local != s.remote {
		return CheckHealth(ctx, s.local)
	}
	return nil
}
