package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"syscall"
	"testing"
	"time"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/repository"
)

type fakePinger struct {
	err    error
	blocks time.Duration
	calls  int
}

func (f *fakePinger) Ping(ctx context.Context) error {
	f.calls++
	if f.blocks > 0 {
		select {
		case <-time.After(f.blocks):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return f.err
}

type fakeStorageChecker struct {
	err   error
	calls int
}

func (f *fakeStorageChecker) CheckHealth(ctx context.Context) error {
	f.calls++
	return f.err
}

type fakeDocQueue struct {
	stats repository.DocumentQueueStats
	err   error
}

func (f *fakeDocQueue) QueueStats(ctx context.Context, window time.Duration) (repository.DocumentQueueStats, error) {
	return f.stats, f.err
}

type fakeCleanupQueue struct {
	stats repository.StorageCleanupQueueStats
	err   error
}

func (f *fakeCleanupQueue) QueueStats(ctx context.Context) (repository.StorageCleanupQueueStats, error) {
	return f.stats, f.err
}

func diagnosticsConfig() config.Config {
	return config.Config{
		AppEnv:          "test",
		ChatAPIKey:      "sk-chat-key",
		ChatModel:       "gpt-test",
		EmbeddingAPIKey: "sk-embedding-key",
		EmbeddingModel:  "embed-test",
		RerankEnabled:   true,
		RerankAPIKey:    "sk-rerank-key",
		RerankModel:     "rerank-test",
	}
}

func dependencyByName(t *testing.T, res *dto.SystemDiagnosticsResponse, name string) dto.SystemDependencyStatus {
	t.Helper()
	for _, dep := range res.Dependencies {
		if dep.Name == name {
			return dep
		}
	}
	t.Fatalf("dependency %q missing from %+v", name, res.Dependencies)
	return dto.SystemDependencyStatus{}
}

func providerByName(t *testing.T, res *dto.SystemDiagnosticsResponse, name string) dto.SystemProviderStatus {
	t.Helper()
	for _, provider := range res.Providers {
		if provider.Name == name {
			return provider
		}
	}
	t.Fatalf("provider %q missing from %+v", name, res.Providers)
	return dto.SystemProviderStatus{}
}

func TestDiagnosticsReportsHealthyDependencies(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{},
		Redis:    &fakePinger{},
		Storage:  &fakeStorageChecker{},
	})

	res := svc.Diagnostics(context.Background())

	if res.Status != dto.SystemStatusOK {
		t.Fatalf("status = %q, want ok", res.Status)
	}
	if len(res.Dependencies) != 3 {
		t.Fatalf("dependencies = %d, want 3", len(res.Dependencies))
	}
	for _, dep := range res.Dependencies {
		if dep.Status != dto.SystemStatusOK {
			t.Errorf("%s status = %q, want ok", dep.Name, dep.Status)
		}
		if dep.Reason != "" {
			t.Errorf("%s reason = %q, want empty", dep.Name, dep.Reason)
		}
		if dep.LatencyMs == nil {
			t.Errorf("%s latency missing", dep.Name)
		}
	}
	if res.CheckedAt.IsZero() {
		t.Error("checkedAt is zero")
	}
	if !res.MetricsSinceRestart {
		t.Error("metricsSinceRestart = false, want true")
	}
}

func TestDiagnosticsReportsDownDatabaseWithoutFailing(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{err: syscall.ECONNREFUSED},
		Redis:    &fakePinger{},
		Storage:  &fakeStorageChecker{},
	})

	res := svc.Diagnostics(context.Background())

	if res.Status != dto.SystemStatusDown {
		t.Fatalf("status = %q, want down", res.Status)
	}
	db := dependencyByName(t, res, "database")
	if db.Status != dto.SystemStatusDown {
		t.Errorf("database status = %q, want down", db.Status)
	}
	if db.Reason != string(observability.ReasonUnreachable) {
		t.Errorf("database reason = %q, want unreachable", db.Reason)
	}
	if redis := dependencyByName(t, res, "redis"); redis.Status != dto.SystemStatusOK {
		t.Errorf("redis status = %q, want ok", redis.Status)
	}
}

func TestDiagnosticsReportsMissingRedisAsNotConfigured(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{},
		Storage:  &fakeStorageChecker{},
	})

	res := svc.Diagnostics(context.Background())

	redis := dependencyByName(t, res, "redis")
	if redis.Status != dto.SystemStatusNotConfigured {
		t.Fatalf("redis status = %q, want not_configured", redis.Status)
	}
	if redis.Reason != string(observability.ReasonNotConfigured) {
		t.Errorf("redis reason = %q, want not_configured", redis.Reason)
	}
	if redis.LatencyMs != nil {
		t.Errorf("redis latency = %v, want nil for an unprobed dependency", *redis.LatencyMs)
	}
	// An intentionally absent dependency must not degrade the overall status,
	// otherwise the field cannot be used as an alert gate.
	if res.Status != dto.SystemStatusOK {
		t.Errorf("status = %q, want ok when a dependency is simply not configured", res.Status)
	}
}

func TestDiagnosticsReportsDownRedis(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{},
		Redis:    &fakePinger{err: syscall.ECONNREFUSED},
		Storage:  &fakeStorageChecker{},
	})

	res := svc.Diagnostics(context.Background())
	redis := dependencyByName(t, res, "redis")
	if redis.Status != dto.SystemStatusDown {
		t.Fatalf("redis status = %q, want down", redis.Status)
	}
	if redis.Reason != string(observability.ReasonUnreachable) {
		t.Errorf("redis reason = %q, want unreachable", redis.Reason)
	}
	if res.Status != dto.SystemStatusDown {
		t.Errorf("overall status = %q, want down", res.Status)
	}
}

func TestDiagnosticsClassifiesAMissingStorageBucket(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{},
		Redis:    &fakePinger{},
		Storage:  &fakeStorageChecker{err: observability.ErrNotFound},
	})

	res := svc.Diagnostics(context.Background())

	storage := dependencyByName(t, res, "storage")
	if storage.Status != dto.SystemStatusDown {
		t.Fatalf("storage status = %q, want down", storage.Status)
	}
	if storage.Reason != string(observability.ReasonNotFound) {
		t.Errorf("storage reason = %q, want not_found", storage.Reason)
	}
}

func TestDiagnosticsBoundsAHangingProbe(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{blocks: 10 * time.Second},
		Redis:    &fakePinger{},
		Storage:  &fakeStorageChecker{},
	})

	start := time.Now()
	res := svc.Diagnostics(context.Background())
	elapsed := time.Since(start)

	if elapsed > 5*time.Second {
		t.Fatalf("diagnostics took %s, want the probe timeout to bound it", elapsed)
	}
	db := dependencyByName(t, res, "database")
	if db.Reason != string(observability.ReasonTimeout) {
		t.Errorf("database reason = %q, want timeout", db.Reason)
	}
}

func TestDiagnosticsNeverCallsModelProviders(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{Database: &fakePinger{}})

	res := svc.Diagnostics(context.Background())

	// Providers are reported from configuration and observed traffic only. With
	// no traffic recorded, every counter must still be zero -- a nonzero count
	// here would mean diagnostics generated billable provider calls itself.
	for _, provider := range res.Providers {
		if provider.SuccessCount != 0 || provider.FailureCount != 0 {
			t.Errorf("provider %s recorded traffic %d/%d, want none", provider.Name, provider.SuccessCount, provider.FailureCount)
		}
	}
	if len(res.Providers) != 3 {
		t.Fatalf("providers = %d, want chat, embedding and rerank", len(res.Providers))
	}
}

func TestDiagnosticsReportsProviderHealthFromRecordedTraffic(t *testing.T) {
	recorder := observability.NewRecorder()
	recorder.RecordProviderResult(observability.ProviderChat, nil)
	recorder.RecordProviderResult(observability.ProviderEmbedding, syscall.ECONNREFUSED)
	recorder.ObserveDuration(observability.MetricRetrieval, 120*time.Millisecond)
	recorder.RecordRerankFallback("provider_error")
	recorder.RecordRateLimitTrigger(observability.RateLimitScopeLogin)
	recorder.RecordRateLimitTrigger(observability.RateLimitScopeLogin)
	recorder.RecordRateLimitTrigger(observability.RateLimitScopeChat)
	recorder.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultHit)
	recorder.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultHit)
	recorder.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultMiss)
	recorder.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultError)
	recorder.RecordVectorExactFallback()

	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{},
		Metrics:  recorder,
		Vector:   fakeVectorInspector{info: repository.PgvectorInfo{Version: "0.5.1"}},
	})

	res := svc.Diagnostics(context.Background())

	if res.VectorSearch.PgvectorVersion != "0.5.1" || res.VectorSearch.IterativeScan || res.VectorSearch.ExactFallbacks != 1 {
		t.Errorf("vector search = %+v, want 0.5.1 without iterative scan and one fallback", res.VectorSearch)
	}

	chat := providerByName(t, res, "chat")
	if chat.Status != dto.SystemStatusOK || chat.SuccessCount != 1 {
		t.Errorf("chat = %+v, want ok with one success", chat)
	}
	if chat.LastSuccessAt == nil {
		t.Error("chat lastSuccessAt missing")
	}

	embedding := providerByName(t, res, "embedding")
	if embedding.Status != dto.SystemStatusDegraded {
		t.Errorf("embedding status = %q, want degraded after a recent failure", embedding.Status)
	}
	if embedding.LastFailureReason != string(observability.ReasonUnreachable) {
		t.Errorf("embedding reason = %q, want unreachable", embedding.LastFailureReason)
	}

	if len(res.Latency) != 1 || res.Latency[0].Metric != observability.MetricRetrieval {
		t.Fatalf("latency = %+v, want one retrieval metric", res.Latency)
	}
	if res.Latency[0].P50Ms != 120 {
		t.Errorf("retrieval p50 = %d, want 120", res.Latency[0].P50Ms)
	}
	if res.RerankFallbacks["provider_error"] != 1 {
		t.Errorf("rerank fallbacks = %+v, want one provider_error", res.RerankFallbacks)
	}
	if res.RateLimitTriggers[observability.RateLimitScopeLogin] != 2 || res.RateLimitTriggers[observability.RateLimitScopeChat] != 1 {
		t.Errorf("rate-limit triggers = %+v, want login=2 and chat=1", res.RateLimitTriggers)
	}
	if res.EmbeddingCache.Hits != 2 || res.EmbeddingCache.Misses != 1 || res.EmbeddingCache.Errors != 1 {
		t.Errorf("embedding cache = %+v, want 2 hits, 1 miss and 1 error", res.EmbeddingCache)
	}
	if res.EmbeddingCache.HitRate == nil || *res.EmbeddingCache.HitRate != 2.0/3.0 {
		t.Errorf("embedding cache hit rate = %v, want 2/3", res.EmbeddingCache.HitRate)
	}
}

func TestDiagnosticsLeavesEmbeddingCacheHitRateNullWithoutLookups(t *testing.T) {
	recorder := observability.NewRecorder()
	recorder.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultError)

	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{Database: &fakePinger{}, Metrics: recorder})
	res := svc.Diagnostics(context.Background())

	if res.EmbeddingCache.HitRate != nil {
		t.Fatalf("embedding cache hit rate = %v, want nil without a hit or miss", *res.EmbeddingCache.HitRate)
	}
	if res.EmbeddingCache.Errors != 1 {
		t.Fatalf("embedding cache errors = %d, want 1", res.EmbeddingCache.Errors)
	}
}

func TestDiagnosticsReportsDisabledRerankAsNotConfigured(t *testing.T) {
	cfg := diagnosticsConfig()
	cfg.RerankEnabled = false
	svc := NewSystemService(cfg)
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{Database: &fakePinger{}})

	rerank := providerByName(t, svc.Diagnostics(context.Background()), "rerank")
	if rerank.Status != dto.SystemStatusNotConfigured {
		t.Errorf("rerank status = %q, want not_configured when disabled", rerank.Status)
	}
	if rerank.Configured {
		t.Error("rerank configured = true, want false when disabled")
	}
}

func TestDiagnosticsTreatsAMissingProviderKeyAsNotConfigured(t *testing.T) {
	cfg := diagnosticsConfig()
	cfg.EmbeddingAPIKey = ""
	svc := NewSystemService(cfg)
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{Database: &fakePinger{}})

	embedding := providerByName(t, svc.Diagnostics(context.Background()), "embedding")
	if embedding.Status != dto.SystemStatusNotConfigured || embedding.Configured {
		t.Errorf("embedding = %+v, want not_configured without a key", embedding)
	}
}

func TestDiagnosticsComputesQueueMetrics(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	oldest := time.Now().Add(-90 * time.Second)
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{},
		Docs: &fakeDocQueue{stats: repository.DocumentQueueStats{
			Pending:         3,
			Running:         1,
			Failed:          5,
			Completed:       40,
			OldestPendingAt: oldest,
			FailedInWindow:  2,
			TotalInWindow:   8,
		}},
		Cleanup: &fakeCleanupQueue{stats: repository.StorageCleanupQueueStats{
			Backlog:          4,
			Retrying:         2,
			Locked:           1,
			OldestEnqueuedAt: oldest,
		}},
	})

	res := svc.Diagnostics(context.Background())
	docs := res.Queues.Documents

	if docs.Pending != 3 || docs.Running != 1 || docs.Failed != 5 {
		t.Errorf("documents = %+v, want 3 pending, 1 running, 5 failed", docs)
	}
	if docs.OldestPendingSeconds == nil || *docs.OldestPendingSeconds < 89 {
		t.Errorf("oldestPendingSeconds = %v, want about 90", docs.OldestPendingSeconds)
	}
	if docs.OldestRunningSeconds != nil {
		t.Errorf("oldestRunningSeconds = %v, want nil when unset", *docs.OldestRunningSeconds)
	}
	if docs.RecentFailureRate == nil || *docs.RecentFailureRate != 0.25 {
		t.Errorf("recentFailureRate = %v, want 0.25", docs.RecentFailureRate)
	}
	if docs.FailureWindowHours != 24 {
		t.Errorf("failureWindowHours = %d, want 24", docs.FailureWindowHours)
	}
	if res.Queues.Cleanup.Backlog != 4 || res.Queues.Cleanup.Retrying != 2 || res.Queues.Cleanup.Locked != 1 {
		t.Errorf("cleanup = %+v, want 4/2/1", res.Queues.Cleanup)
	}
}

func TestDiagnosticsLeavesFailureRateNullWithoutFinishedJobs(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{},
		Docs:     &fakeDocQueue{stats: repository.DocumentQueueStats{Pending: 2}},
	})

	// Null and zero are different answers: an idle window has no rate, and
	// rendering it as 0% would claim a success record the server does not have.
	if rate := svc.Diagnostics(context.Background()).Queues.Documents.RecentFailureRate; rate != nil {
		t.Fatalf("recentFailureRate = %v, want nil for an empty window", *rate)
	}
}

func TestDiagnosticsSurvivesQueueQueryFailure(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{},
		Docs:     &fakeDocQueue{err: errors.New("relation \"document_jobs\" does not exist")},
		Cleanup:  &fakeCleanupQueue{err: errors.New("boom")},
	})

	res := svc.Diagnostics(context.Background())
	if res.Queues.Documents.Pending != 0 {
		t.Errorf("pending = %d, want zero when the query failed", res.Queues.Documents.Pending)
	}
	if res.Status != dto.SystemStatusOK {
		t.Errorf("status = %q, want the probe result to drive status", res.Status)
	}
}

func TestDiagnosticsWorksWithoutAnyDependencies(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())

	res := svc.Diagnostics(context.Background())

	if res.Status != dto.SystemStatusOK {
		t.Errorf("status = %q, want ok", res.Status)
	}
	if len(res.Dependencies) != 3 {
		t.Fatalf("dependencies = %d, want all three reported as not_configured", len(res.Dependencies))
	}
	if res.RerankFallbacks == nil {
		t.Error("rerankFallbacks is nil, want an empty map so the UI can iterate it")
	}
	if res.RateLimitTriggers == nil {
		t.Error("rateLimitTriggers is nil, want an empty map so clients can iterate it")
	}
	if res.EmbeddingCache.HitRate != nil {
		t.Errorf("embedding cache hit rate = %v, want nil before any lookups", *res.EmbeddingCache.HitRate)
	}
}

// TestDiagnosticsResponseNeverSerializesSecrets is the enforcement point for the
// requirement that health output must not return keys, connection strings or raw
// provider errors.
func TestDiagnosticsResponseNeverSerializesSecrets(t *testing.T) {
	const (
		dsn         = "postgres://rag:supersecret@db.internal:5432/rag?sslmode=disable"
		chatKey     = "sk-chat-abcdef0123456789"
		redisPass   = "redis-hunter2"
		minioKey    = "minio-secret-key-value"
		providerRaw = "429 Too Many Requests from https://api.vendor.internal/v1: quota for key sk-chat-abcdef0123456789 exhausted"
	)

	cfg := diagnosticsConfig()
	cfg.DatabaseURL = dsn
	cfg.ChatAPIKey = chatKey
	cfg.EmbeddingAPIKey = chatKey
	cfg.RerankAPIKey = chatKey
	cfg.RedisPassword = redisPass
	cfg.ChatBaseURL = "https://api.vendor.internal/v1"
	cfg.MinIOSecretKey = minioKey

	recorder := observability.NewRecorder()
	recorder.RecordProviderResult(observability.ProviderChat, errors.New(providerRaw))

	svc := NewSystemService(cfg)
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{err: errors.New("dial tcp db.internal:5432: connect: connection refused (" + dsn + ")")},
		Redis:    &fakePinger{err: errors.New("NOAUTH Authentication required, tried " + redisPass)},
		Storage:  &fakeStorageChecker{err: errors.New("The Access Key Id you provided does not exist: " + minioKey)},
		Metrics:  recorder,
	})

	encoded, err := json.Marshal(svc.Diagnostics(context.Background()))
	if err != nil {
		t.Fatalf("marshal diagnostics: %v", err)
	}
	payload := string(encoded)

	for _, secret := range []string{dsn, chatKey, redisPass, minioKey, providerRaw, "db.internal", "api.vendor.internal", "supersecret"} {
		if strings.Contains(payload, secret) {
			t.Errorf("diagnostics payload leaked %q", secret)
		}
	}
}

func TestHealthReportsNamesAndStatusesOnly(t *testing.T) {
	const dsn = "postgres://rag:supersecret@db.internal:5432/rag"

	cfg := diagnosticsConfig()
	cfg.DatabaseURL = dsn
	svc := NewSystemService(cfg)
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{
		Database: &fakePinger{err: errors.New("dial " + dsn + ": connection refused")},
		Storage:  &fakeStorageChecker{},
	})

	res := svc.Health(context.Background())

	if res.Status != dto.SystemStatusDown {
		t.Fatalf("status = %q, want down", res.Status)
	}
	if res.Env != "test" {
		t.Errorf("env = %q, want test", res.Env)
	}
	if res.Dependencies["database"] != dto.SystemStatusDown {
		t.Errorf("database = %q, want down", res.Dependencies["database"])
	}
	if _, ok := res.Dependencies["redis"]; ok {
		t.Error("redis reported, want unconfigured dependencies omitted from liveness")
	}

	encoded, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal health: %v", err)
	}
	// The liveness endpoint is unauthenticated, so it carries no reasons and no
	// latencies -- only whether each dependency answers.
	for _, forbidden := range []string{dsn, "supersecret", "unreachable", "latency"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Errorf("health payload contains %q", forbidden)
		}
	}
}

func TestHealthStaysOKWhenEverythingAnswers(t *testing.T) {
	svc := NewSystemService(diagnosticsConfig())
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{Database: &fakePinger{}, Redis: &fakePinger{}, Storage: &fakeStorageChecker{}})

	res := svc.Health(context.Background())
	if res.Status != dto.SystemStatusOK {
		t.Fatalf("status = %q, want ok", res.Status)
	}
	if len(res.Dependencies) != 3 {
		t.Errorf("dependencies = %+v, want all three", res.Dependencies)
	}
}

type fakeVectorInspector struct {
	info repository.PgvectorInfo
}

func (f fakeVectorInspector) Pgvector(context.Context) repository.PgvectorInfo {
	return f.info
}
