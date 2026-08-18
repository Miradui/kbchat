package storage

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
)

func TestNormalizeMinIOEndpoint(t *testing.T) {
	tests := []struct {
		name       string
		input      string
		configured bool
		endpoint   string
		secure     bool
	}{
		{name: "http URL", input: "http://minio.example.test:9000", configured: true, endpoint: "minio.example.test:9000", secure: false},
		{name: "https URL", input: "https://minio.example.test", endpoint: "minio.example.test", secure: true},
		{name: "host and port", input: "minio.example.test:9000", configured: true, endpoint: "minio.example.test:9000", secure: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			endpoint, secure, err := normalizeMinIOEndpoint(tt.input, tt.configured)
			if err != nil {
				t.Fatalf("normalize endpoint: %v", err)
			}
			if endpoint != tt.endpoint || secure != tt.secure {
				t.Fatalf("expected endpoint=%q secure=%t, got endpoint=%q secure=%t", tt.endpoint, tt.secure, endpoint, secure)
			}
		})
	}
}

func TestMinIOBucketReadinessErrorClassification(t *testing.T) {
	if !minIOBucketAlreadyExists(minio.ErrorResponse{Code: "BucketAlreadyOwnedByYou"}) {
		t.Fatal("expected same-owner bucket creation race to be accepted")
	}
	if minIOBucketAlreadyExists(errors.New("permission denied")) {
		t.Fatal("expected unrelated bucket creation error to be rejected")
	}
	if !minIONoBucketPolicy(minio.ErrorResponse{Code: "NoSuchBucketPolicy"}) {
		t.Fatal("expected absent bucket policy to mean private bucket")
	}
}

func TestNormalizeMinIOEndpointRejectsPathsAndCredentials(t *testing.T) {
	for _, endpoint := range []string{
		"http://user:password@minio.example.test:9000",
		"http://minio.example.test:9000/api",
		"ftp://minio.example.test:9000",
	} {
		if _, _, err := normalizeMinIOEndpoint(endpoint, false); err == nil {
			t.Fatalf("expected %q to be rejected", endpoint)
		}
	}
}

func TestKnowledgeBaseObjectKeyDoesNotUseOriginalFilename(t *testing.T) {
	kbID := uuid.MustParse("6a879ced-4385-4db9-9857-4a61ed7dc7cc")
	key := knowledgeBaseObjectKey(kbID, `..\\private\\report.PDF`)
	if len(key) != len(kbID.String())+1+len(uuid.NewString())+len(".pdf") {
		t.Fatalf("unexpected object key length: %q", key)
	}
	if key[:len(kbID.String())+1] != kbID.String()+"/" || key[len(key)-4:] != ".pdf" {
		t.Fatalf("unexpected object key: %q", key)
	}
}
