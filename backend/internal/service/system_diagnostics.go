package service

import (
	"context"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/repository"
)

// probeTimeout bounds each dependency probe.
//
// A diagnostics page is most useful precisely when a dependency is hanging, so
// the probe must fail fast rather than inherit the request deadline: an operator
// waiting 30s for a page that exists to tell them something is slow has been
// told nothing they could not already see.
const probeTimeout = 2 * time.Second

// documentFailureWindow is the span the recent document failure rate covers.
const documentFailureWindow = 24 * time.Hour

// Narrow interfaces, so tests can supply a dead dependency without a live
// PostgreSQL, Redis or MinIO.
type systemPinger interface {
	Ping(ctx context.Context) error
}

type systemStorageChecker interface {
	CheckHealth(ctx context.Context) error
}

type systemDocumentQueueStatter interface {
	QueueStats(ctx context.Context, window time.Duration) (repository.DocumentQueueStats, error)
}

type systemVectorSearchInspector interface {
	Pgvector(ctx context.Context) repository.PgvectorInfo
}

type systemCleanupQueueStatter interface {
	QueueStats(ctx context.Context) (repository.StorageCleanupQueueStats, error)
}

// SystemDiagnosticsDeps are the optional collaborators diagnostics needs.
//
// Every field may be nil: a deployment without Redis, a test without storage and
// the existing NewSystemService callers must all keep working. A nil dependency
// reports not_configured rather than failing the request.
type SystemDiagnosticsDeps struct {
	Database systemPinger
	Redis    systemPinger
	Storage  systemStorageChecker
	Docs     systemDocumentQueueStatter
	Cleanup  systemCleanupQueueStatter
	Vector   systemVectorSearchInspector
	Metrics  *observability.Recorder
	Logger   *zap.Logger
}

// SetDiagnosticsDeps wires diagnostics after construction, following the
// SetActivityRecorder precedent so NewSystemService's signature and its existing
// callers stay unchanged.
func (s *SystemService) SetDiagnosticsDeps(deps SystemDiagnosticsDeps) {
	s.diag = deps
}

func (s *SystemService) logger() *zap.Logger {
	if s.diag.Logger == nil {
		return zap.NewNop()
	}
	return s.diag.Logger
}

type probeResult struct {
	name    string
	status  string
	reason  observability.Reason
	latency *int64
}

// Diagnostics reports dependency, queue, provider and latency state.
//
// It never returns an error for a failing dependency. A dead database is the
// answer, not an error: a 500 here would leave the operator with the same blank
// page they came to diagnose. Errors are logged in full and reduced to a closed
// reason set on the way out, because driver and provider errors routinely embed
// connection strings and keys.
func (s *SystemService) Diagnostics(ctx context.Context) *dto.SystemDiagnosticsResponse {
	checkedAt := time.Now().UTC()

	probes := []struct {
		name  string
		probe func(context.Context) error
	}{
		{name: "database", probe: pingerProbe(s.diag.Database)},
		{name: "redis", probe: pingerProbe(s.diag.Redis)},
		{name: "storage", probe: storageProbe(s.diag.Storage)},
	}

	results := make([]probeResult, len(probes))
	var wg sync.WaitGroup
	for i, p := range probes {
		if p.probe == nil {
			results[i] = probeResult{name: p.name, status: dto.SystemStatusNotConfigured, reason: observability.ReasonNotConfigured}
			continue
		}
		wg.Add(1)
		go func(idx int, name string, probe func(context.Context) error) {
			defer wg.Done()
			results[idx] = s.runProbe(ctx, name, probe)
		}(i, p.name, p.probe)
	}
	wg.Wait()

	dependencies := make([]dto.SystemDependencyStatus, 0, len(results))
	overall := dto.SystemStatusOK
	for _, res := range results {
		dependencies = append(dependencies, dto.SystemDependencyStatus{
			Name:      res.name,
			Status:    res.status,
			Reason:    string(res.reason),
			LatencyMs: res.latency,
		})
		overall = worseStatus(overall, res.status)
	}

	snapshot := s.diag.Metrics.Snapshot()

	return &dto.SystemDiagnosticsResponse{
		Status:              overall,
		CheckedAt:           checkedAt,
		Env:                 s.cfg.AppEnv,
		Dependencies:        dependencies,
		Queues:              s.queueStatus(ctx),
		Providers:           s.providerStatuses(snapshot),
		Latency:             latencyMetrics(snapshot),
		RerankFallbacks:     snapshot.RerankFallbacks,
		RateLimitTriggers:   snapshot.RateLimitTriggers,
		EmbeddingCache:      embeddingCacheMetrics(snapshot.EmbeddingCacheResult),
		VectorSearch:        s.vectorSearchStatus(ctx, snapshot),
		Embedding:           s.embeddingStatus(ctx),
		MetricsSinceRestart: true,
	}
}

func (s *SystemService) vectorSearchStatus(ctx context.Context, snapshot observability.Snapshot) dto.SystemVectorSearchStatus {
	status := dto.SystemVectorSearchStatus{ExactFallbacks: snapshot.VectorExactFallbacks}
	if s.diag.Vector != nil {
		info := s.diag.Vector.Pgvector(ctx)
		status.PgvectorVersion = info.Version
		status.IterativeScan = info.IterativeScan
	}
	return status
}

func embeddingCacheMetrics(stats observability.EmbeddingCacheStats) dto.SystemEmbeddingCacheMetrics {
	metrics := dto.SystemEmbeddingCacheMetrics{
		Hits:   stats.Hits,
		Misses: stats.Misses,
		Errors: stats.Errors,
	}
	lookups := stats.Hits + stats.Misses
	if lookups > 0 {
		hitRate := float64(stats.Hits) / float64(lookups)
		metrics.HitRate = &hitRate
	}
	return metrics
}

// Health is the unauthenticated liveness view: names and statuses only.
func (s *SystemService) Health(ctx context.Context) *dto.SystemHealthResponse {
	res := &dto.SystemHealthResponse{Status: dto.SystemStatusOK, Env: s.cfg.AppEnv}

	probes := map[string]func(context.Context) error{
		"database": pingerProbe(s.diag.Database),
		"redis":    pingerProbe(s.diag.Redis),
		"storage":  storageProbe(s.diag.Storage),
	}

	dependencies := make(map[string]string, len(probes))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for name, probe := range probes {
		if probe == nil {
			continue
		}
		wg.Add(1)
		go func(name string, probe func(context.Context) error) {
			defer wg.Done()
			result := s.runProbe(ctx, name, probe)
			mu.Lock()
			defer mu.Unlock()
			dependencies[name] = result.status
			res.Status = worseStatus(res.Status, result.status)
		}(name, probe)
	}
	wg.Wait()

	if len(dependencies) > 0 {
		res.Dependencies = dependencies
	}
	return res
}

func (s *SystemService) runProbe(ctx context.Context, name string, probe func(context.Context) error) probeResult {
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	start := time.Now()
	err := probe(probeCtx)
	elapsed := time.Since(start).Milliseconds()

	if err != nil {
		// Logged at full fidelity on purpose. The no-secrets rule constrains the
		// HTTP response, not the operator's own server log, which is the only
		// place the underlying cause can actually be read.
		s.logger().Warn("dependency probe failed", zap.String("dependency", name), zap.Error(err))
		reason := observability.Classify(err)
		return probeResult{name: name, status: dto.SystemStatusDown, reason: reason, latency: &elapsed}
	}
	return probeResult{name: name, status: dto.SystemStatusOK, latency: &elapsed}
}

func pingerProbe(p systemPinger) func(context.Context) error {
	if p == nil {
		return nil
	}
	return p.Ping
}

func storageProbe(c systemStorageChecker) func(context.Context) error {
	if c == nil {
		return nil
	}
	return c.CheckHealth
}

// worseStatus collapses dependency statuses into one overall value.
//
// not_configured does not degrade the overall status: a deployment that
// intentionally runs without Redis is healthy, not degraded, and reporting
// otherwise would make the field useless as an alert gate.
func worseStatus(current, next string) string {
	rank := map[string]int{
		dto.SystemStatusOK:            0,
		dto.SystemStatusNotConfigured: 0,
		dto.SystemStatusDegraded:      1,
		dto.SystemStatusDown:          2,
	}
	if rank[next] > rank[current] {
		if next == dto.SystemStatusNotConfigured {
			return current
		}
		return next
	}
	return current
}

func (s *SystemService) queueStatus(ctx context.Context) dto.SystemQueuesStatus {
	status := dto.SystemQueuesStatus{
		Documents: dto.SystemDocumentQueueStatus{
			FailureWindowHours: int(documentFailureWindow / time.Hour),
		},
	}

	if s.diag.Docs != nil {
		stats, err := s.diag.Docs.QueueStats(ctx, documentFailureWindow)
		if err != nil {
			s.logger().Warn("read document queue stats", zap.Error(err))
		} else {
			status.Documents.Pending = stats.Pending
			status.Documents.Running = stats.Running
			status.Documents.Failed = stats.Failed
			status.Documents.Completed = stats.Completed
			status.Documents.Cancelled = stats.Cancelled
			status.Documents.OldestPendingSeconds = ageSeconds(stats.OldestPendingAt)
			status.Documents.OldestRunningSeconds = ageSeconds(stats.OldestRunningAt)
			status.Documents.FinishedInWindow = stats.TotalInWindow
			status.Documents.FailedInWindow = stats.FailedInWindow
			if stats.TotalInWindow > 0 {
				rate := float64(stats.FailedInWindow) / float64(stats.TotalInWindow)
				status.Documents.RecentFailureRate = &rate
			}
		}
	}

	if s.diag.Cleanup != nil {
		stats, err := s.diag.Cleanup.QueueStats(ctx)
		if err != nil {
			s.logger().Warn("read cleanup queue stats", zap.Error(err))
		} else {
			status.Cleanup.Backlog = stats.Backlog
			status.Cleanup.Retrying = stats.Retrying
			status.Cleanup.Locked = stats.Locked
			status.Cleanup.OldestPendingSeconds = ageSeconds(stats.OldestEnqueuedAt)
		}
	}

	return status
}

// ageSeconds converts a timestamp to an age, or nil when there is nothing to age.
// Negative ages are clamped: a scheduled-in-the-future retry is pending, not
// pending for minus five minutes.
func ageSeconds(at time.Time) *int64 {
	if at.IsZero() {
		return nil
	}
	seconds := int64(time.Since(at).Seconds())
	if seconds < 0 {
		seconds = 0
	}
	return &seconds
}

func latencyMetrics(snapshot observability.Snapshot) []dto.SystemLatencyMetric {
	metrics := make([]dto.SystemLatencyMetric, 0, len(snapshot.Durations))
	for name, stats := range snapshot.Durations {
		metrics = append(metrics, dto.SystemLatencyMetric{
			Metric:      name,
			Count:       stats.Count,
			SampleCount: stats.SampleCount,
			P50Ms:       stats.P50.Milliseconds(),
			P95Ms:       stats.P95.Milliseconds(),
			MaxMs:       stats.Max.Milliseconds(),
		})
	}
	sort.Slice(metrics, func(i, j int) bool { return metrics[i].Metric < metrics[j].Metric })
	return metrics
}

// providerStatuses reports configuration completeness plus health observed from
// real traffic.
//
// A provider is "configured" when it has both a key and a model: either alone
// produces a request that fails at call time, which is the failure this panel
// exists to catch before a user hits it. Rerank is reported even when disabled,
// because "rerank looks broken" and "rerank is switched off" are the two answers
// an operator is choosing between, and omitting the row answers neither.
func (s *SystemService) providerStatuses(snapshot observability.Snapshot) []dto.SystemProviderStatus {
	type providerConfig struct {
		name     string
		metric   string
		apiKey   string
		model    string
		disabled bool
	}

	configs := []providerConfig{
		{name: "chat", metric: observability.ProviderChat, apiKey: s.cfg.ChatAPIKey, model: s.cfg.ChatModel},
		{name: "embedding", metric: observability.ProviderEmbedding, apiKey: s.cfg.EmbeddingAPIKey, model: s.cfg.EmbeddingModel},
		{name: "rerank", metric: observability.ProviderRerank, apiKey: s.cfg.RerankAPIKey, model: s.cfg.RerankModel, disabled: !s.cfg.RerankEnabled},
		// Title generation falls back to the chat credentials, matching how the
		// provider is actually built.
		{name: "title", metric: observability.ProviderTitle, apiKey: firstNonEmpty(s.cfg.TitleAPIKey, s.cfg.ChatAPIKey), model: s.cfg.TitleModel},
	}

	statuses := make([]dto.SystemProviderStatus, 0, len(configs))
	for _, cfg := range configs {
		configured := cfg.apiKey != "" && cfg.model != ""
		status := dto.SystemProviderStatus{
			Name:       cfg.name,
			Configured: configured,
			Model:      cfg.model,
			Status:     dto.SystemStatusOK,
		}

		switch {
		case cfg.disabled:
			status.Status = dto.SystemStatusNotConfigured
			status.Configured = false
		case !configured:
			status.Status = dto.SystemStatusNotConfigured
		}

		if stats, ok := snapshot.Providers[cfg.metric]; ok {
			status.SuccessCount = stats.SuccessCount
			status.FailureCount = stats.FailureCount
			status.RecentFailures = stats.RecentFailureCount
			status.LastFailureReason = string(stats.LastFailureReason)
			if !stats.LastSuccessAt.IsZero() {
				at := stats.LastSuccessAt.UTC()
				status.LastSuccessAt = &at
			}
			if !stats.LastFailureAt.IsZero() {
				at := stats.LastFailureAt.UTC()
				status.LastFailureAt = &at
			}
			// Recent failures degrade rather than down a provider: the recorder
			// only sees traffic, so a provider with recent failures and recent
			// successes is flaky, and one with no traffic at all is unknown, not
			// dead. Neither justifies claiming it is down.
			if stats.RecentFailureCount > 0 && status.Status == dto.SystemStatusOK {
				status.Status = dto.SystemStatusDegraded
			}
		}

		statuses = append(statuses, status)
	}

	return statuses
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
