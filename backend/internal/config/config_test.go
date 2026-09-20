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

func TestValidateRejectsNegativeStaleDocumentThreshold(t *testing.T) {
	// Rejected rather than clamped: a negative threshold would mark every document
	// stale on upload, and reading it as "disabled" would hide the typo.
	err := (Config{
		JWTSecret:              strings.Repeat("a", 32),
		MaxUploadSizeMB:        50,
		StorageProvider:        "local",
		StaleDocumentAfterDays: -1,
	}).Validate()
	if err == nil || !strings.Contains(err.Error(), "STALE_DOCUMENT_AFTER_DAYS") {
		t.Fatalf("expected STALE_DOCUMENT_AFTER_DAYS validation error, got %v", err)
	}
}

func TestValidateAcceptsDisabledStaleDocumentThreshold(t *testing.T) {
	// 0 is the documented way to turn the flag off, so it must stay valid.
	err := (Config{
		JWTSecret:              strings.Repeat("a", 32),
		MaxUploadSizeMB:        50,
		StorageProvider:        "local",
		StaleDocumentAfterDays: 0,
	}).Validate()
	if err != nil {
		t.Fatalf("expected a disabled threshold to be valid, got %v", err)
	}
}

func TestDefaultStaleDocumentThresholdMatchesTheExampleEnvironment(t *testing.T) {
	values, err := godotenv.Read("../../../.env.example")
	if err != nil {
		t.Fatalf("read example environment: %v", err)
	}
	want := strconv.Itoa(defaultStaleDocumentAfterDays)
	if got := values["STALE_DOCUMENT_AFTER_DAYS"]; got != want {
		t.Fatalf("example environment and code default disagree: example %q, default %q", got, want)
	}
}

func TestLoadUsesP2RedisDefaults(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("JWT_SECRET", strings.Repeat("a", 32))
	t.Setenv("RATE_LIMIT_ENABLED", "true")
	t.Setenv("RATE_LIMIT_LOGIN_PER_MINUTE", "10")
	t.Setenv("RATE_LIMIT_CHAT_PER_MINUTE", "30")
	t.Setenv("RATE_LIMIT_FAILURE_MODE", "open")
	t.Setenv("TRUSTED_PROXY_CIDRS", "10.0.0.0/8, 192.168.0.0/16")
	t.Setenv("EMBEDDING_CACHE_TTL", "24h")

	cfg := Load()
	if !cfg.RateLimitEnabled || cfg.RateLimitLoginPerMinute != 10 || cfg.RateLimitChatPerMinute != 30 {
		t.Fatalf("unexpected rate-limit defaults: %#v", cfg)
	}
	if cfg.RateLimitFailureMode != "open" {
		t.Fatalf("expected open failure mode, got %q", cfg.RateLimitFailureMode)
	}
	if !reflect.DeepEqual(cfg.TrustedProxyCIDRs, []string{"10.0.0.0/8", "192.168.0.0/16"}) {
		t.Fatalf("unexpected trusted proxies: %q", cfg.TrustedProxyCIDRs)
	}
	if cfg.EmbeddingCacheTTL != 24*time.Hour {
		t.Fatalf("expected a 24h embedding cache TTL, got %s", cfg.EmbeddingCacheTTL)
	}
}

func TestConfigValidateRejectsInvalidP2RedisSettings(t *testing.T) {
	base := Config{
		JWTSecret:               strings.Repeat("a", 32),
		MaxUploadSizeMB:         50,
		StorageProvider:         "local",
		RedisAddr:               "localhost:6379",
		RateLimitEnabled:        true,
		RateLimitLoginPerMinute: 10,
		RateLimitChatPerMinute:  30,
		RateLimitFailureMode:    "open",
		EmbeddingCacheTTL:       24 * time.Hour,
	}

	tests := []struct {
		name   string
		mutate func(*Config)
		want   string
	}{
		{name: "login limit", mutate: func(c *Config) { c.RateLimitLoginPerMinute = 0 }, want: "RATE_LIMIT_LOGIN_PER_MINUTE"},
		{name: "chat limit", mutate: func(c *Config) { c.RateLimitChatPerMinute = -1 }, want: "RATE_LIMIT_CHAT_PER_MINUTE"},
		{name: "failure mode", mutate: func(c *Config) { c.RateLimitFailureMode = "sometimes" }, want: "RATE_LIMIT_FAILURE_MODE"},
		{name: "trusted proxy", mutate: func(c *Config) { c.TrustedProxyCIDRs = []string{"not-a-cidr"} }, want: "TRUSTED_PROXY_CIDRS"},
		{name: "cache ttl", mutate: func(c *Config) { c.EmbeddingCacheTTL = 0 }, want: "EMBEDDING_CACHE_TTL"},
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

func TestExampleEnvironmentMatchesP2RedisDefaults(t *testing.T) {
	values, err := godotenv.Read("../../../.env.example")
	if err != nil {
		t.Fatalf("read example environment: %v", err)
	}
	want := map[string]string{
		"RATE_LIMIT_ENABLED":          "true",
		"RATE_LIMIT_LOGIN_PER_MINUTE": "10",
		"RATE_LIMIT_CHAT_PER_MINUTE":  "30",
		"RATE_LIMIT_FAILURE_MODE":     "open",
		"TRUSTED_PROXY_CIDRS":         "",
		"EMBEDDING_CACHE_TTL":         "24h",
	}
	for key, expected := range want {
		if got := values[key]; got != expected {
			t.Errorf("%s = %q, want %q", key, got, expected)
		}
	}
}
