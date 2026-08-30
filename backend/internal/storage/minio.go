package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"kbchat/backend/internal/observability"
)

const minIOScheme = "minio://"

type MinIOConfig struct {
	Endpoint         string
	AccessKey        string
	SecretKey        string
	Bucket           string
	Region           string
	UseSSL           bool
	OperationTimeout time.Duration
}

type MinIOStorage struct {
	client           *minio.Client
	bucket           string
	region           string
	operationTimeout time.Duration
	bucketMu         sync.Mutex
	bucketReady      bool
}

func NewMinIOStorage(cfg MinIOConfig) (*MinIOStorage, error) {
	if strings.TrimSpace(cfg.AccessKey) == "" || strings.TrimSpace(cfg.SecretKey) == "" || strings.TrimSpace(cfg.Bucket) == "" {
		return nil, fmt.Errorf("MinIO access key, secret key, and bucket are required")
	}
	endpoint, secure, err := normalizeMinIOEndpoint(cfg.Endpoint, cfg.UseSSL)
	if err != nil {
		return nil, err
	}
	if cfg.OperationTimeout <= 0 {
		cfg.OperationTimeout = 2 * time.Minute
	}
	transport, err := minio.DefaultTransport(secure)
	if err != nil {
		return nil, fmt.Errorf("create MinIO transport: %w", err)
	}
	transport.ResponseHeaderTimeout = cfg.OperationTimeout
	client, err := minio.New(endpoint, &minio.Options{
		Creds:     credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure:    secure,
		Region:    cfg.Region,
		Transport: transport,
	})
	if err != nil {
		return nil, fmt.Errorf("create MinIO client: %w", err)
	}
	return &MinIOStorage{client: client, bucket: cfg.Bucket, region: cfg.Region, operationTimeout: cfg.OperationTimeout}, nil
}

func (s *MinIOStorage) EnsureReady(ctx context.Context) error {
	return s.ensureBucket(ctx)
}

// CheckHealth verifies the bucket is reachable without creating or modifying
// anything, so it is safe to call from a request handler. A missing bucket is
// reported as observability.ErrNotFound rather than being silently created,
// because a bucket that vanished is an operational fact worth surfacing.
func (s *MinIOStorage) CheckHealth(ctx context.Context) error {
	probeCtx, cancel := s.operationContext(ctx)
	defer cancel()
	exists, err := s.client.BucketExists(probeCtx, s.bucket)
	if err != nil {
		return fmt.Errorf("check MinIO bucket: %w", err)
	}
	if !exists {
		return fmt.Errorf("MinIO bucket is absent: %w", observability.ErrNotFound)
	}
	return nil
}

func normalizeMinIOEndpoint(value string, configuredSSL bool) (string, bool, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false, fmt.Errorf("MINIO_ENDPOINT is required")
	}
	secure := configuredSSL
	if !strings.Contains(value, "://") {
		if strings.ContainsAny(value, `/\\`) {
			return "", false, fmt.Errorf("MINIO_ENDPOINT must not include a path")
		}
		return value, secure, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", false, fmt.Errorf("invalid MINIO_ENDPOINT")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false, fmt.Errorf("MINIO_ENDPOINT scheme must be http or https")
	}
	if parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false, fmt.Errorf("MINIO_ENDPOINT must contain only scheme, host, and port")
	}
	return parsed.Host, parsed.Scheme == "https", nil
}

func (s *MinIOStorage) NewKnowledgeBaseFileLocation(kbID uuid.UUID, filename string) string {
	return minIOScheme + s.bucket + "/" + knowledgeBaseObjectKey(kbID, filename)
}

func (s *MinIOStorage) SaveKnowledgeBaseFile(ctx context.Context, location string, file *multipart.FileHeader) error {
	operationCtx, cancel := s.operationContext(ctx)
	defer cancel()
	if err := s.ensureBucket(operationCtx); err != nil {
		return err
	}
	source, err := file.Open()
	if err != nil {
		return err
	}
	defer source.Close()

	key, err := s.objectKey(location)
	if err != nil {
		return err
	}
	contentType := mime.TypeByExtension(path.Ext(key))
	if _, err := s.client.PutObject(operationCtx, s.bucket, key, source, file.Size, minio.PutObjectOptions{ContentType: contentType}); err != nil {
		return fmt.Errorf("put MinIO object: %w", err)
	}
	return nil
}

func (s *MinIOStorage) Delete(ctx context.Context, location string) error {
	if location == "" {
		return nil
	}
	key, err := s.objectKey(location)
	if err != nil {
		return err
	}
	operationCtx, cancel := s.operationContext(ctx)
	defer cancel()
	if err := s.client.RemoveObject(operationCtx, s.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("remove MinIO object: %w", err)
	}
	return nil
}

func (s *MinIOStorage) Open(ctx context.Context, location string) (io.ReadCloser, ObjectInfo, error) {
	key, err := s.objectKey(location)
	if err != nil {
		return nil, ObjectInfo{}, err
	}
	operationCtx, cancel := s.operationContext(ctx)
	stat, err := s.client.StatObject(operationCtx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		cancel()
		return nil, ObjectInfo{}, minIOStorageError(err)
	}
	object, err := s.client.GetObject(operationCtx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		cancel()
		return nil, ObjectInfo{}, minIOStorageError(err)
	}
	return &cancelReadCloser{ReadCloser: object, cancel: cancel}, ObjectInfo{Size: stat.Size, LastModified: stat.LastModified}, nil
}

func (s *MinIOStorage) Read(ctx context.Context, location string) ([]byte, error) {
	reader, _, err := s.Open(ctx, location)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	content, err := io.ReadAll(reader)
	return content, minIOStorageError(err)
}

func (s *MinIOStorage) Stat(ctx context.Context, location string) (ObjectInfo, error) {
	key, err := s.objectKey(location)
	if err != nil {
		return ObjectInfo{}, err
	}
	operationCtx, cancel := s.operationContext(ctx)
	defer cancel()
	stat, err := s.client.StatObject(operationCtx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return ObjectInfo{}, minIOStorageError(err)
	}
	return ObjectInfo{Size: stat.Size, LastModified: stat.LastModified}, nil
}

func (s *MinIOStorage) Materialize(ctx context.Context, location string) (string, func(), error) {
	reader, _, err := s.Open(ctx, location)
	if err != nil {
		return "", nil, err
	}
	defer reader.Close()

	temporary, err := os.CreateTemp("", "rag-document-*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.Remove(temporary.Name()) }
	if _, err := io.Copy(temporary, reader); err != nil {
		_ = temporary.Close()
		cleanup()
		return "", nil, err
	}
	if err := temporary.Close(); err != nil {
		cleanup()
		return "", nil, err
	}
	return temporary.Name(), cleanup, nil
}

func (s *MinIOStorage) ensureBucket(ctx context.Context) error {
	s.bucketMu.Lock()
	defer s.bucketMu.Unlock()
	if s.bucketReady {
		return nil
	}
	exists, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return fmt.Errorf("check MinIO bucket: %w", err)
	}
	if !exists {
		if err := s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{Region: s.region}); err != nil {
			if !minIOBucketAlreadyExists(err) {
				return fmt.Errorf("create MinIO bucket: %w", err)
			}
			exists, checkErr := s.client.BucketExists(ctx, s.bucket)
			if checkErr != nil || !exists {
				return fmt.Errorf("verify concurrently created MinIO bucket: %w", errors.Join(err, checkErr))
			}
		}
	}
	if err := s.ensurePrivateBucket(ctx); err != nil {
		return err
	}
	s.bucketReady = true
	return nil
}

func (s *MinIOStorage) operationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if s.operationTimeout <= 0 {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, s.operationTimeout)
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (r *cancelReadCloser) Close() error {
	err := r.ReadCloser.Close()
	r.cancel()
	return err
}

func (s *MinIOStorage) ensurePrivateBucket(ctx context.Context) error {
	policy, err := s.client.GetBucketPolicy(ctx, s.bucket)
	if err != nil {
		if minIONoBucketPolicy(err) {
			return nil
		}
		return fmt.Errorf("check MinIO bucket policy: %w", err)
	}
	if strings.TrimSpace(policy) != "" {
		return fmt.Errorf("MinIO bucket %q has a bucket policy; remove it so document access remains private", s.bucket)
	}
	return nil
}

func minIOBucketAlreadyExists(err error) bool {
	code := minio.ToErrorResponse(err).Code
	return code == "BucketAlreadyOwnedByYou" || code == "BucketAlreadyExists"
}

func minIONoBucketPolicy(err error) bool {
	code := minio.ToErrorResponse(err).Code
	return code == "NoSuchBucketPolicy" || code == "NoSuchPolicy"
}

func (s *MinIOStorage) objectKey(location string) (string, error) {
	prefix := minIOScheme + s.bucket + "/"
	if !strings.HasPrefix(location, prefix) {
		return "", fmt.Errorf("MinIO location does not belong to configured bucket")
	}
	key := strings.TrimPrefix(location, prefix)
	if key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "\\") {
		return "", fmt.Errorf("invalid MinIO object key")
	}
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("invalid MinIO object key")
		}
	}
	return key, nil
}

func minIOStorageError(err error) error {
	if err == nil {
		return nil
	}
	code := minio.ToErrorResponse(err).Code
	if code == "NoSuchKey" || code == "NoSuchObject" || code == "NotFound" {
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	}
	return err
}
