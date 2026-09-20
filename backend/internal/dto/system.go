package dto

import "time"

type SystemUploadCapabilities struct {
	MaxFileBytes      int64    `json:"maxFileBytes"`
	AllowedExtensions []string `json:"allowedExtensions"`
}

type SystemRetrievalCapabilities struct {
	MaxVectorTopN int `json:"maxVectorTopN"`
	MaxRerankTopK int `json:"maxRerankTopK"`
}

type SystemAccountCapabilities struct {
	MinPasswordLength    int      `json:"minPasswordLength"`
	MaxPasswordBytes     int      `json:"maxPasswordBytes"`
	MaxDisplayNameLength int      `json:"maxDisplayNameLength"`
	MaxAvatarURLLength   int      `json:"maxAvatarUrlLength"`
	MaxAvatarBytes       int      `json:"maxAvatarBytes"`
	AvatarSize           int      `json:"avatarSize"`
	AvatarContentTypes   []string `json:"avatarContentTypes"`
}

// SystemCapabilitiesResponse mirrors the server-side limits the frontend used to
// hardcode. Every value comes from the same constant or config entry the request
// path enforces, so the two cannot drift.
type SystemCapabilitiesResponse struct {
	RerankEnabled bool `json:"rerankEnabled"`
	// KeywordSearchEnabled mirrors KEYWORD_SEARCH_ENABLED so the retrieval form
	// can explain why a knowledge base's enableKeyword has no effect.
	KeywordSearchEnabled bool                        `json:"keywordSearchEnabled"`
	ChatModels           []string                    `json:"chatModels"`
	Upload               SystemUploadCapabilities    `json:"upload"`
	Retrieval            SystemRetrievalCapabilities `json:"retrieval"`
	Account              SystemAccountCapabilities   `json:"account"`
}

// Dependency and overall status values.
const (
	SystemStatusOK            = "ok"
	SystemStatusDegraded      = "degraded"
	SystemStatusDown          = "down"
	SystemStatusNotConfigured = "not_configured"
)

// SystemDependencyStatus is one probed dependency.
//
// Reason is a closed set from the observability package, never an error message:
// health output must not carry keys, connection strings or raw provider errors,
// and driver errors embed exactly those. There is deliberately no field for a
// host, endpoint, DSN or bucket name.
type SystemDependencyStatus struct {
	Name      string `json:"name"`
	Status    string `json:"status"`
	Reason    string `json:"reason,omitempty"`
	LatencyMs *int64 `json:"latencyMs"`
}

// SystemProviderStatus is a model provider's configuration and observed health.
//
// Providers are not probed: there is no unpriced ping in the OpenAI-compatible
// surface, so a synthetic call would bill the operator per page view. Instead
// this reports whether the provider is wired and what its real traffic has shown.
// Model is included because it identifies a misconfiguration an operator can act
// on; the base URL is not, because it is deployment topology.
type SystemProviderStatus struct {
	Name              string     `json:"name"`
	Configured        bool       `json:"configured"`
	Model             string     `json:"model,omitempty"`
	Status            string     `json:"status"`
	LastSuccessAt     *time.Time `json:"lastSuccessAt"`
	LastFailureAt     *time.Time `json:"lastFailureAt"`
	LastFailureReason string     `json:"lastFailureReason,omitempty"`
	SuccessCount      uint64     `json:"successCount"`
	FailureCount      uint64     `json:"failureCount"`
	RecentFailures    int        `json:"recentFailures"`
}

// SystemDocumentQueueStatus is the document processing queue.
//
// OldestPendingSeconds and OldestRunningSeconds are null when nothing is in that
// state. RecentFailureRate is null when the window contains no finished jobs,
// which is different from a zero rate and must not be rendered as success.
type SystemDocumentQueueStatus struct {
	Pending              int64    `json:"pending"`
	Running              int64    `json:"running"`
	Failed               int64    `json:"failed"`
	Completed            int64    `json:"completed"`
	Cancelled            int64    `json:"cancelled"`
	OldestPendingSeconds *int64   `json:"oldestPendingSeconds"`
	OldestRunningSeconds *int64   `json:"oldestRunningSeconds"`
	FailureWindowHours   int      `json:"failureWindowHours"`
	FinishedInWindow     int64    `json:"finishedInWindow"`
	FailedInWindow       int64    `json:"failedInWindow"`
	RecentFailureRate    *float64 `json:"recentFailureRate"`
}

// SystemCleanupQueueStatus is the object cleanup queue, whose stalling leaks
// storage silently.
type SystemCleanupQueueStatus struct {
	Backlog              int64  `json:"backlog"`
	Retrying             int64  `json:"retrying"`
	Locked               int64  `json:"locked"`
	OldestPendingSeconds *int64 `json:"oldestPendingSeconds"`
}

type SystemQueuesStatus struct {
	Documents SystemDocumentQueueStatus `json:"documents"`
	Cleanup   SystemCleanupQueueStatus  `json:"cleanup"`
}

// SystemLatencyMetric summarizes one timing metric. SampleCount is how many
// samples the percentiles were computed from, which is capped by the recorder's
// ring and so can be lower than Count.
type SystemLatencyMetric struct {
	Metric      string `json:"metric"`
	Count       uint64 `json:"count"`
	SampleCount int    `json:"sampleCount"`
	P50Ms       int64  `json:"p50Ms"`
	P95Ms       int64  `json:"p95Ms"`
	MaxMs       int64  `json:"maxMs"`
}

// SystemEmbeddingCacheMetrics summarizes query-embedding cache lookups since
// process start. HitRate is null until at least one hit or miss has been
// observed; cache errors do not enter its denominator.
type SystemEmbeddingCacheMetrics struct {
	Hits    uint64   `json:"hits"`
	Misses  uint64   `json:"misses"`
	Errors  uint64   `json:"errors"`
	HitRate *float64 `json:"hitRate"`
}

// SystemDiagnosticsResponse is the diagnostics payload.
//
// Latency, fallbacks, rate limits and cache metrics are per-process and reset
// when the server restarts, which the UI states explicitly rather than implying
// a durable history. Status is the worst of the dependency statuses, so a caller
// can gate on one field.
type SystemDiagnosticsResponse struct {
	Status            string                      `json:"status"`
	CheckedAt         time.Time                   `json:"checkedAt"`
	Env               string                      `json:"env"`
	Dependencies      []SystemDependencyStatus    `json:"dependencies"`
	Queues            SystemQueuesStatus          `json:"queues"`
	Providers         []SystemProviderStatus      `json:"providers"`
	Latency           []SystemLatencyMetric       `json:"latency"`
	RerankFallbacks   map[string]uint64           `json:"rerankFallbacks"`
	RateLimitTriggers map[string]uint64           `json:"rateLimitTriggers"`
	EmbeddingCache    SystemEmbeddingCacheMetrics `json:"embeddingCache"`
	// MetricsSinceRestart is always true today. It exists so a future durable
	// metrics store can say otherwise without a breaking contract change.
	MetricsSinceRestart bool `json:"metricsSinceRestart"`
}

// SystemHealthResponse is the unauthenticated liveness payload.
//
// It keeps the original {status, env} shape and adds dependency names with
// statuses only -- no reasons, no latencies, no counts. An unauthenticated
// endpoint that says which dependency failed and why is a reconnaissance aid, but
// one that always says ok is a lie that defeats every orchestrator health gate.
type SystemHealthResponse struct {
	Status       string            `json:"status"`
	Env          string            `json:"env"`
	Dependencies map[string]string `json:"dependencies,omitempty"`
}
