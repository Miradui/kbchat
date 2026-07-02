package config

import (
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

const (
	defaultAppEnv             = "development"
	defaultServerPort         = "8080"
	defaultDatabaseURL        = "postgres://rag:rag@localhost:5432/rag?sslmode=disable"
	defaultRedisAddr          = "localhost:6379"
	defaultRedisDB            = 0
	defaultJWTExpiresIn       = "24h"
	defaultModelProvider      = "openai_compatible"
	defaultChatBaseURL        = "https://api.openai.com/v1"
	defaultChatModel          = "gpt-4.1-mini"
	defaultTitleBaseURL       = "https://api.openai.com/v1"
	defaultTitleModel         = "gpt-4.1-mini"
	defaultEmbeddingBaseURL   = "https://api.openai.com/v1"
	defaultEmbeddingModel     = "text-embedding-3-small"
	defaultEmbeddingDimension = 1536
	defaultRerankBaseURL      = "https://api.openai.com/v1"
	defaultRerankModel        = "rerank-model-name"
	defaultUploadDir          = "./uploads"
	defaultMaxUploadSizeMB    = 50
	defaultVectorTopN         = 30
	defaultRerankTopK         = 5
	defaultScoreThreshold     = 0.3
	defaultRerankEnabled      = true
	defaultChatHistoryLimit   = 10
	defaultWorkerConcurrency  = 2
	defaultWorkerMaxRetries   = 3
	defaultWorkerRetryDelay   = 10 * time.Second
)

type Config struct {
	AppEnv             string
	ServerPort         string
	DatabaseURL        string
	RedisAddr          string
	RedisPassword      string
	RedisDB            int
	JWTSecret          string
	JWTExpiresIn       string
	ModelProvider      string
	ChatBaseURL        string
	ChatAPIKey         string
	ChatModel          string
	TitleBaseURL       string
	TitleAPIKey        string
	TitleModel         string
	EmbeddingBaseURL   string
	EmbeddingAPIKey    string
	EmbeddingModel     string
	EmbeddingDimension int
	RerankEnabled      bool
	RerankBaseURL      string
	RerankAPIKey       string
	RerankModel        string
	UploadDir          string
	MaxUploadSizeMB    int
	VectorTopN         int
	RerankTopK         int
	ScoreThreshold     float64
	ChatHistoryLimit   int
	WorkerConcurrency  int
	WorkerMaxRetries   int
	WorkerRetryDelay   time.Duration
}

func Load() Config {
	loadDotEnv()

	return Config{
		AppEnv:             getEnv("APP_ENV", defaultAppEnv),
		ServerPort:         getEnv("SERVER_PORT", defaultServerPort),
		DatabaseURL:        getEnv("DATABASE_URL", defaultDatabaseURL),
		RedisAddr:          getEnv("REDIS_ADDR", defaultRedisAddr),
		RedisPassword:      getEnv("REDIS_PASSWORD", ""),
		RedisDB:            getEnvInt("REDIS_DB", defaultRedisDB),
		JWTSecret:          getEnv("JWT_SECRET", ""),
		JWTExpiresIn:       getEnv("JWT_EXPIRES_IN", defaultJWTExpiresIn),
		ModelProvider:      getEnv("MODEL_PROVIDER", defaultModelProvider),
		ChatBaseURL:        normalizedBaseURL(getEnv("CHAT_BASE_URL", getEnv("OPENAI_BASE_URL", defaultChatBaseURL))),
		ChatAPIKey:         getEnv("CHAT_API_KEY", getEnv("OPENAI_API_KEY", "")),
		ChatModel:          getEnv("CHAT_MODEL", defaultChatModel),
		TitleBaseURL:       normalizedBaseURL(getEnv("TITLE_BASE_URL", defaultTitleBaseURL)),
		TitleAPIKey:        getEnv("TITLE_API_KEY", ""),
		TitleModel:         getEnv("TITLE_MODEL", defaultTitleModel),
		EmbeddingBaseURL:   normalizedBaseURL(getEnv("EMBEDDING_BASE_URL", getEnv("OPENAI_BASE_URL", defaultEmbeddingBaseURL))),
		EmbeddingAPIKey:    getEnv("EMBEDDING_API_KEY", getEnv("OPENAI_API_KEY", "")),
		EmbeddingModel:     getEnv("EMBEDDING_MODEL", defaultEmbeddingModel),
		EmbeddingDimension: getEnvInt("EMBEDDING_DIMENSION", defaultEmbeddingDimension),
		RerankEnabled:      getEnvBool("RERANK_ENABLED", getEnvBool("ENABLE_RERANK", defaultRerankEnabled)),
		RerankBaseURL:      normalizedBaseURL(getEnv("RERANK_BASE_URL", getEnv("OPENAI_BASE_URL", defaultRerankBaseURL))),
		RerankAPIKey:       getEnv("RERANK_API_KEY", getEnv("OPENAI_API_KEY", "")),
		RerankModel:        getEnv("RERANK_MODEL", defaultRerankModel),
		UploadDir:          getEnv("UPLOAD_DIR", defaultUploadDir),
		MaxUploadSizeMB:    getEnvInt("MAX_UPLOAD_SIZE_MB", defaultMaxUploadSizeMB),
		VectorTopN:         getEnvInt("VECTOR_TOP_N", defaultVectorTopN),
		RerankTopK:         getEnvInt("RERANK_TOP_K", defaultRerankTopK),
		ScoreThreshold:     getEnvFloat("SCORE_THRESHOLD", defaultScoreThreshold),
		ChatHistoryLimit:   getEnvInt("CHAT_HISTORY_LIMIT", defaultChatHistoryLimit),
		WorkerConcurrency:  getEnvInt("WORKER_CONCURRENCY", defaultWorkerConcurrency),
		WorkerMaxRetries:   getEnvInt("WORKER_MAX_RETRIES", defaultWorkerMaxRetries),
		WorkerRetryDelay:   getEnvDuration("WORKER_RETRY_DELAY", defaultWorkerRetryDelay),
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
		_ = godotenv.Overload(path)
	}
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
