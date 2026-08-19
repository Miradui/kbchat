package config

import (
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/joho/godotenv"
)

func TestSplitCommaSeparatedTrimsAndSkipsEmptyValues(t *testing.T) {
	got := splitCommaSeparated(" https://first.example.test, ,https://second.example.test  ")
	want := []string{"https://first.example.test", "https://second.example.test"}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected origins %q, got %q", want, got)
	}
}

func TestValidateJWTSecretRejectsUnsafeValues(t *testing.T) {
	tests := []struct {
		name   string
		secret string
	}{
		{name: "empty", secret: ""},
		{name: "whitespace", secret: "   "},
		{name: "legacy fallback", secret: "replace-with-local-secret"},
		{name: "example placeholder", secret: "change-me-to-a-long-random-secret"},
		{name: "too short", secret: "short-secret"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := ValidateJWTSecret(tt.secret); err == nil {
				t.Fatalf("expected JWT secret %q to be rejected", tt.secret)
			}
		})
	}
}

func TestValidateJWTSecretAcceptsSufficientLength(t *testing.T) {
	if err := ValidateJWTSecret("unit-test-secret-with-at-least-32-bytes"); err != nil {
		t.Fatalf("expected sufficiently long JWT secret to be accepted: %v", err)
	}
}

func TestConfigValidateRejectsUnsafeMaxUploadSize(t *testing.T) {
	tests := []struct {
		name  string
		value int
	}{
		{name: "zero", value: 0},
		{name: "negative", value: -1},
	}
	if strconv.IntSize == 64 {
		tests = append(tests, struct {
			name  string
			value int
		}{name: "byte conversion overflow", value: int(^uint(0) >> 1)})
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := (Config{
				JWTSecret:       "unit-test-secret-with-at-least-32-bytes",
				MaxUploadSizeMB: tt.value,
			}).Validate()
			if err == nil || !strings.Contains(err.Error(), "MAX_UPLOAD_SIZE_MB") {
				t.Fatalf("expected MAX_UPLOAD_SIZE_MB validation error, got %v", err)
			}
		})
	}
}

func TestLoadPreservesInvalidMaxUploadSizeForValidation(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("JWT_SECRET", "unit-test-secret-with-at-least-32-bytes")
	t.Setenv("MAX_UPLOAD_SIZE_MB", "50MB")

	cfg := Load()
	if cfg.MaxUploadSizeMB == defaultMaxUploadSizeMB {
		t.Fatalf("expected invalid MAX_UPLOAD_SIZE_MB to avoid the default, got %d", cfg.MaxUploadSizeMB)
	}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "MAX_UPLOAD_SIZE_MB") {
		t.Fatalf("expected MAX_UPLOAD_SIZE_MB validation error, got %v", err)
	}
}

func TestConfigValidateMinIOStorage(t *testing.T) {
	base := Config{
		JWTSecret:               "unit-test-secret-with-at-least-32-bytes",
		MaxUploadSizeMB:         50,
		StorageProvider:         "minio",
		MinIOEndpoint:           "http://minio.example.test:9000",
		MinIOAccessKey:          "test-access-key",
		MinIOSecretKey:          "test-secret-key",
		MinIOBucket:             "rag-documents",
		StorageOperationTimeout: 2 * time.Minute,
	}
	if err := base.Validate(); err != nil {
		t.Fatalf("expected complete MinIO config to validate: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Config)
		want   string
	}{
		{name: "endpoint", mutate: func(c *Config) { c.MinIOEndpoint = "" }, want: "MINIO_ENDPOINT"},
		{name: "access key", mutate: func(c *Config) { c.MinIOAccessKey = "" }, want: "MINIO_ACCESS_KEY"},
		{name: "secret key", mutate: func(c *Config) { c.MinIOSecretKey = "" }, want: "MINIO_SECRET_KEY"},
		{name: "bucket", mutate: func(c *Config) { c.MinIOBucket = "" }, want: "MINIO_BUCKET"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := base
			tt.mutate(&cfg)
			err := cfg.Validate()
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected %s validation error, got %v", tt.want, err)
			}
		})
	}
}

func TestConfigValidateRejectsUnknownStorageProvider(t *testing.T) {
	err := (Config{
		JWTSecret:       "unit-test-secret-with-at-least-32-bytes",
		MaxUploadSizeMB: 50,
		StorageProvider: "ftp",
	}).Validate()
	if err == nil || !strings.Contains(err.Error(), "STORAGE_PROVIDER") {
		t.Fatalf("expected STORAGE_PROVIDER validation error, got %v", err)
	}
}

func TestLoadKeepsProcessEnvironmentOverDotEnvFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/.env", []byte("SERVER_PORT=8080\n"), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	t.Chdir(dir)
	t.Setenv("SERVER_PORT", "9090")

	if got := Load().ServerPort; got != "9090" {
		t.Fatalf("expected process environment to win, got %q", got)
	}
}

func TestExampleEnvironmentEnablesRerank(t *testing.T) {
	values, err := godotenv.Read("../../../.env.example")
	if err != nil {
		t.Fatalf("read example environment: %v", err)
	}
	if got := values["RERANK_ENABLED"]; got != "true" {
		t.Fatalf("expected standard RAG example to enable rerank, got %q", got)
	}
}
