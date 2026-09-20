package config

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

const (
	defaultAppEnv                  = "development"
	defaultServerPort              = "8080"
	defaultCORSAllowedOrigins      = "http://127.0.0.1:5173,http://localhost:5173"
	defaultDatabaseURL             = "postgres://rag:rag@localhost:5432/rag?sslmode=disable"
	defaultRedisAddr               = "localhost:6379"
	defaultRedisDB                 = 0
	defaultRateLimitEnabled        = true
	defaultRateLimitLoginPerMinute = 10
	defaultRateLimitChatPerMinute  = 30
	defaultRateLimitFailureMode    = "open"
	defaultEmbeddingCacheTTL       = 24 * time.Hour
	defaultJWTExpiresIn            = "24h"
	defaultModelProvider           = "openai_compatible"
	defaultChatBaseURL             = "https://api.openai.com/v1"
	defaultChatModel               = "gpt-4.1-mini"
	defaultTitleBaseURL            = "https://api.openai.com/v1"
	defaultTitleModel              = "gpt-4.1-mini"
	defaultEmbeddingBaseURL        = "https://api.openai.com/v1"
	defaultEmbeddingModel          = "text-embedding-3-small"
	defaultEmbeddingDimension      = 1536
	defaultRerankBaseURL           = "https://api.openai.com/v1"
	defaultRerankModel             = "rerank-model-name"
	defaultRerankFailureMode       = "strict"
	defaultStorageProvider         = "local"
	defaultUploadDir               = "./uploads"
	defaultMinIOBucket             = "rag-documents"
	defaultMinIOUseSSL             = false
	defaultMaxUploadSizeMB         = 50
	defaultVectorTopN              = 30
	defaultRerankTopK              = 5
	defaultScoreThreshold          = 0.3
	defaultRerankEnabled           = true
	defaultKeywordSearchEnabled    = true
	defaultChatHistoryLimit        = 10
	defaultWorkerConcurrency       = 2
	defaultWorkerMaxRetries        = 3
	defaultWorkerRetryDelay        = 10 * time.Second
	defaultStorageOperationTimeout = 2 * time.Minute
	defaultStaleDocumentAfterDays  = 180
	minJWTSecretBytes              = 32
	bytesPerMiB                    = int64(1024 * 1024)
	uploadRequestOverhead          = bytesPerMiB
	maxInt64Value                  = int64(1<<63 - 1)
)

type Config struct {
	AppEnv                  string
	ServerPort              string
	CORSAllowedOrigins      []string
	DatabaseURL             string
	RedisAddr               string
	RedisPassword           string
	RedisDB                 int
	RateLimitEnabled        bool
	RateLimitLoginPerMinute int
	RateLimitChatPerMinute  int
	RateLimitFailureMode    string
	TrustedProxyCIDRs       []string
	EmbeddingCacheTTL       time.Duration
	JWTSecret               string
	JWTExpiresIn            string
	ModelProvider           string
	ChatBaseURL             string
	ChatAPIKey              string
	ChatModel               string
	TitleBaseURL            string
	TitleAPIKey             string
	TitleModel              string
	EmbeddingBaseURL        string
	EmbeddingAPIKey         string
	EmbeddingModel          string
	EmbeddingDimension      int
	RerankEnabled           bool
	// KeywordSearchEnabled is the global switch for the keyword recall stage; a
	// knowledge base cannot turn it on when this is false, mirroring RerankEnabled.
	KeywordSearchEnabled bool
	RerankBaseURL        string
	RerankAPIKey         string
	RerankModel          string
	RerankFailureMode    string
	StorageProvider      string
	UploadDir            string
	MinIOEndpoint        string
	MinIOAccessKey       string
	MinIOSecretKey       string
	MinIOBucket          string
	MinIORegion          string
	MinIOUseSSL          bool
	MaxUploadSizeMB      int
	// StaleDocumentAfterDays is how long a processed document goes without being
	// updated before the UI flags it as possibly out of date. 0 disables the flag.
	// A document is never deleted or down-weighted in retrieval for being stale:
	// old is not the same as wrong, and silently demoting content the user still
	// relies on would make answers worse with no way to see why.
	StaleDocumentAfterDays  int
	VectorTopN              int
	RerankTopK              int
	ScoreThreshold          float64
	ChatHistoryLimit        int
	WorkerConcurrency       int
	WorkerMaxRetries        int
	WorkerRetryDelay        time.Duration
	StorageOperationTimeout time.Duration
}

func Load() Config {
	loadDotEnv()

	return Config{
		AppEnv:                  getEnv("APP_ENV", defaultAppEnv),
		ServerPort:              getEnv("SERVER_PORT", defaultServerPort),
		CORSAllowedOrigins:      splitCommaSeparated(getEnv("CORS_ALLOWED_ORIGINS", defaultCORSAllowedOrigins)),
		DatabaseURL:             getEnv("DATABASE_URL", defaultDatabaseURL),
		RedisAddr:               getEnv("REDIS_ADDR", defaultRedisAddr),
		RedisPassword:           getEnv("REDIS_PASSWORD", ""),
		RedisDB:                 getEnvInt("REDIS_DB", defaultRedisDB),
		RateLimitEnabled:        getEnvBool("RATE_LIMIT_ENABLED", defaultRateLimitEnabled),
		RateLimitLoginPerMinute: getEnvInt("RATE_LIMIT_LOGIN_PER_MINUTE", defaultRateLimitLoginPerMinute),
		RateLimitChatPerMinute:  getEnvInt("RATE_LIMIT_CHAT_PER_MINUTE", defaultRateLimitChatPerMinute),
		RateLimitFailureMode:    strings.ToLower(strings.TrimSpace(getEnv("RATE_LIMIT_FAILURE_MODE", defaultRateLimitFailureMode))),
		TrustedProxyCIDRs:       splitCommaSeparated(getEnv("TRUSTED_PROXY_CIDRS", "")),
		EmbeddingCacheTTL:       getEnvDuration("EMBEDDING_CACHE_TTL", defaultEmbeddingCacheTTL),
		JWTSecret:               getEnv("JWT_SECRET", ""),
		JWTExpiresIn:            getEnv("JWT_EXPIRES_IN", defaultJWTExpiresIn),
		ModelProvider:           getEnv("MODEL_PROVIDER", defaultModelProvider),
		ChatBaseURL:             normalizedBaseURL(getEnv("CHAT_BASE_URL", getEnv("OPENAI_BASE_URL", defaultChatBaseURL))),
		ChatAPIKey:              getEnv("CHAT_API_KEY", getEnv("OPENAI_API_KEY", "")),
		ChatModel:               getEnv("CHAT_MODEL", defaultChatModel),
		TitleBaseURL:            normalizedBaseURL(getEnv("TITLE_BASE_URL", defaultTitleBaseURL)),
		TitleAPIKey:             getEnv("TITLE_API_KEY", ""),
		TitleModel:              getEnv("TITLE_MODEL", defaultTitleModel),
		EmbeddingBaseURL:        normalizedBaseURL(getEnv("EMBEDDING_BASE_URL", getEnv("OPENAI_BASE_URL", defaultEmbeddingBaseURL))),
		EmbeddingAPIKey:         getEnv("EMBEDDING_API_KEY", getEnv("OPENAI_API_KEY", "")),
		EmbeddingModel:          getEnv("EMBEDDING_MODEL", defaultEmbeddingModel),
		EmbeddingDimension:      getEnvInt("EMBEDDING_DIMENSION", defaultEmbeddingDimension),
		RerankEnabled:           getEnvBool("RERANK_ENABLED", getEnvBool("ENABLE_RERANK", defaultRerankEnabled)),
		KeywordSearchEnabled:    getEnvBool("KEYWORD_SEARCH_ENABLED", defaultKeywordSearchEnabled),
		RerankBaseURL:           normalizedBaseURL(getEnv("RERANK_BASE_URL", getEnv("OPENAI_BASE_URL", defaultRerankBaseURL))),
		RerankAPIKey:            getEnv("RERANK_API_KEY", getEnv("OPENAI_API_KEY", "")),
		RerankModel:             getEnv("RERANK_MODEL", defaultRerankModel),
		RerankFailureMode:       normalizeRerankFailureMode(getEnv("RERANK_FAILURE_MODE", defaultRerankFailureMode)),
		StorageProvider:         normalizeStorageProvider(getEnv("STORAGE_PROVIDER", defaultStorageProvider)),
		UploadDir:               getEnv("UPLOAD_DIR", defaultUploadDir),
		MinIOEndpoint:           strings.TrimSpace(getEnv("MINIO_ENDPOINT", "")),
		MinIOAccessKey:          getEnv("MINIO_ACCESS_KEY", ""),
		MinIOSecretKey:          getEnv("MINIO_SECRET_KEY", ""),
		MinIOBucket:             strings.TrimSpace(getEnv("MINIO_BUCKET", defaultMinIOBucket)),
		MinIORegion:             strings.TrimSpace(getEnv("MINIO_REGION", "")),
		MinIOUseSSL:             getEnvBool("MINIO_USE_SSL", defaultMinIOUseSSL),
		MaxUploadSizeMB:         getEnvUploadSizeMB(defaultMaxUploadSizeMB),
		StaleDocumentAfterDays:  getEnvInt("STALE_DOCUMENT_AFTER_DAYS", defaultStaleDocumentAfterDays),
		VectorTopN:              getEnvInt("VECTOR_TOP_N", defaultVectorTopN),
		RerankTopK:              getEnvInt("RERANK_TOP_K", defaultRerankTopK),
		ScoreThreshold:          getEnvFloat("SCORE_THRESHOLD", defaultScoreThreshold),
		ChatHistoryLimit:        getEnvInt("CHAT_HISTORY_LIMIT", defaultChatHistoryLimit),
		WorkerConcurrency:       getEnvInt("WORKER_CONCURRENCY", defaultWorkerConcurrency),
		WorkerMaxRetries:        getEnvInt("WORKER_MAX_RETRIES", defaultWorkerMaxRetries),
		WorkerRetryDelay:        getEnvDuration("WORKER_RETRY_DELAY", defaultWorkerRetryDelay),
		StorageOperationTimeout: getEnvDuration("STORAGE_OPERATION_TIMEOUT", defaultStorageOperationTimeout),
	}
}

func (c Config) Validate() error {
	if err := ValidateJWTSecret(c.JWTSecret); err != nil {
		return err
	}
	if err := validateMaxUploadSizeMB(c.MaxUploadSizeMB); err != nil {
		return err
	}
	// Rejected rather than clamped: a negative threshold would mark every document
	// stale on upload, and silently reading it as "disabled" would hide the typo
	// that caused it.
	if c.StaleDocumentAfterDays < 0 {
		return fmt.Errorf("STALE_DOCUMENT_AFTER_DAYS must not be negative")
	}
	if err := validateRateLimitConfig(c); err != nil {
		return err
	}
	if c.RedisAddr != "" && c.EmbeddingCacheTTL <= 0 {
		return fmt.Errorf("EMBEDDING_CACHE_TTL must be greater than zero")
	}
	return validateStorageConfig(c)
}

func validateRateLimitConfig(c Config) error {
	if c.RateLimitEnabled {
		if c.RateLimitLoginPerMinute <= 0 {
			return fmt.Errorf("RATE_LIMIT_LOGIN_PER_MINUTE must be greater than zero")
		}
		if c.RateLimitChatPerMinute <= 0 {
			return fmt.Errorf("RATE_LIMIT_CHAT_PER_MINUTE must be greater than zero")
		}
	}
	if c.RateLimitFailureMode != "" && c.RateLimitFailureMode != "open" && c.RateLimitFailureMode != "closed" {
		return fmt.Errorf("RATE_LIMIT_FAILURE_MODE must be open or closed")
	}
	for _, value := range c.TrustedProxyCIDRs {
		if _, _, err := net.ParseCIDR(value); err != nil {
			return fmt.Errorf("TRUSTED_PROXY_CIDRS contains invalid CIDR %q", value)
		}
	}
	return nil
}

func validateStorageConfig(c Config) error {
	provider := normalizeStorageProvider(c.StorageProvider)
	if provider == "" {
		provider = defaultStorageProvider
	}
	switch provider {
	case "local":
		return nil
	case "minio":
		required := []struct {
			name  string
			value string
		}{
			{name: "MINIO_ENDPOINT", value: c.MinIOEndpoint},
			{name: "MINIO_ACCESS_KEY", value: c.MinIOAccessKey},
			{name: "MINIO_SECRET_KEY", value: c.MinIOSecretKey},
			{name: "MINIO_BUCKET", value: c.MinIOBucket},
		}
		for _, item := range required {
			if strings.TrimSpace(item.value) == "" {
				return fmt.Errorf("%s is required when STORAGE_PROVIDER=minio", item.name)
			}
		}
		if c.StorageOperationTimeout <= 0 {
			return fmt.Errorf("STORAGE_OPERATION_TIMEOUT must be greater than zero")
		}
		return nil
	default:
		return fmt.Errorf("STORAGE_PROVIDER must be local or minio")
	}
}

func ValidateJWTSecret(value string) error {
	secret := strings.TrimSpace(value)
	if secret == "" {
		return fmt.Errorf("JWT_SECRET is required")
	}
	if secret == "replace-with-local-secret" || secret == "change-me-to-a-long-random-secret" {
		return fmt.Errorf("JWT_SECRET must replace the documented placeholder")
	}
	if len([]byte(secret)) < minJWTSecretBytes {
		return fmt.Errorf("JWT_SECRET must be at least %d bytes", minJWTSecretBytes)
	}
	return nil
}

func validateMaxUploadSizeMB(value int) error {
	if value <= 0 {
		return fmt.Errorf("MAX_UPLOAD_SIZE_MB must be greater than zero")
	}
	maxSafeValue := (maxInt64Value - uploadRequestOverhead) / bytesPerMiB
	if int64(value) > maxSafeValue {
		return fmt.Errorf("MAX_UPLOAD_SIZE_MB is too large")
	}
	return nil
}

func splitCommaSeparated(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			result = append(result, part)
		}
	}
	return result
}

func normalizeRerankFailureMode(value string) string {
	switch value {
	case "fallback":
		return "fallback"
	default:
		return defaultRerankFailureMode
	}
}

func loadDotEnv() {
	paths := []string{
		".env",
		"../.env",
		"../../.env",
		"../../../.env",
	}

	for _, path := range paths {
		_ = godotenv.Load(path)
	}
}

func normalizeStorageProvider(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func getEnv(key, fallback string) string {
	value, ok := os.LookupEnv(key)
	if !ok || value == "" {
		return fallback
	}
	return value
}

func getEnvInt(key string, fallback int) int {
	value, ok := os.LookupEnv(key)
	if !ok || value == "" {
		return fallback
	}

	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getEnvUploadSizeMB(fallback int) int {
	value, ok := os.LookupEnv("MAX_UPLOAD_SIZE_MB")
	if !ok || value == "" {
		return fallback
	}

	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return parsed
}

func getEnvFloat(key string, fallback float64) float64 {
	value, ok := os.LookupEnv(key)
	if !ok || value == "" {
		return fallback
	}

	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func getEnvBool(key string, fallback bool) bool {
	value, ok := os.LookupEnv(key)
	if !ok || value == "" {
		return fallback
	}

	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getEnvDuration(key string, fallback time.Duration) time.Duration {
	value, ok := os.LookupEnv(key)
	if !ok || value == "" {
		return fallback
	}

	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func normalizedBaseURL(value string) string {
	if value == "" {
		return value
	}
	if len(value) >= len("http://") && value[:len("http://")] == "http://" {
		return value
	}
	if len(value) >= len("https://") && value[:len("https://")] == "https://" {
		return value
	}
	return "https://" + value
}
