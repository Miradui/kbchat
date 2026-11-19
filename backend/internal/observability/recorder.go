// Package observability collects per-process request timings, dependency
// outcomes and operational counters for the diagnostics endpoint.
//
// Everything here is deliberately in-memory and bounded: the values are one to
// three per chat request, so a row per value would add write amplification to
// the hot path and grow without limit to serve a page that is read rarely. The
// cost is that all figures reset when the process restarts, which the API
// documentation and the diagnostics page both state explicitly. Durability is
// covered separately by logging each timing through zap.
package observability

import (
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"
)

// Metric names recorded by the chat and retrieval paths. They are exported so
// the call sites and the diagnostics service cannot drift on spelling.
const (
	MetricRetrieval      = "retrieval"
	MetricEmbedding      = "embedding"
	MetricRerank         = "rerank"
	MetricKeyword        = "keyword"
	MetricChatFirstToken = "chat_first_token"
	MetricChatGeneration = "chat_generation"
)

// Provider names used with RecordProviderResult.
const (
	ProviderChat      = "chat"
	ProviderEmbedding = "embedding"
	ProviderRerank    = "rerank"
	// ProviderKeyword is the PostgreSQL full-text stage. It is not a remote
	// provider, but its failures need the same visibility because keyword
	// recall silently falls back to vector recall when it breaks.
	ProviderKeyword = "keyword"
)

// Rate-limit scopes are deliberately a closed set. Keeping the recorder's
// counter keys bounded prevents an attacker-controlled identifier from turning
// process metrics into an unbounded map.
const (
	RateLimitScopeLogin = "login"
	RateLimitScopeChat  = "chat"
)

// Embedding-cache outcomes are recorded separately so an unavailable cache is
// visible without treating the provider fallback as a genuine cache miss.
const (
	EmbeddingCacheResultHit   = "hit"
	EmbeddingCacheResultMiss  = "miss"
	EmbeddingCacheResultError = "error"
)

// sampleCapacity is the per-metric ring size. It covers a meaningful recent
// window for percentiles while keeping the whole recorder to a few hundred
// kilobytes regardless of uptime.
const sampleCapacity = 512

// recentFailureWindow bounds the failure counts reported per provider, so an
// outage an hour ago stops making a currently healthy provider look broken.
const recentFailureWindow = 15 * time.Minute

// durationRing is a fixed-size ring of samples. Once full it overwrites the
// oldest sample, which is what keeps memory flat under sustained traffic.
type durationRing struct {
	samples []time.Duration
	next    int
	total   uint64
}

func (r *durationRing) add(value time.Duration) {
	if len(r.samples) < sampleCapacity {
		r.samples = append(r.samples, value)
	} else {
		r.samples[r.next] = value
		r.next = (r.next + 1) % sampleCapacity
	}
	r.total++
}

// providerHealth is what a provider's real traffic has shown recently. The
// diagnostics endpoint reports this instead of probing the provider, because
// there is no unpriced ping in the OpenAI-compatible surface this repository
// uses and a synthetic call would bill the operator per page view.
type providerHealth struct {
	lastSuccessAt time.Time
	lastFailureAt time.Time
	lastReason    Reason
	failures      []time.Time
	successCount  uint64
	failureCount  uint64
}

// Recorder accumulates timings and provider outcomes. Every method is safe for
// concurrent use and is a no-op on a nil receiver, so instrumentation can be
// added to call paths whose existing tests construct services without one.
type Recorder struct {
	mu                   sync.Mutex
	durations            map[string]*durationRing
	providers            map[string]*providerHealth
	fallbacks            map[string]uint64
	rateLimitTriggers    map[string]uint64
	embeddingCacheResult EmbeddingCacheStats
	vectorExactFallbacks uint64
	now                  func() time.Time
	logger               *zap.Logger
}

func NewRecorder() *Recorder {
	return &Recorder{
		durations:         map[string]*durationRing{},
		providers:         map[string]*providerHealth{},
		fallbacks:         map[string]uint64{},
		rateLimitTriggers: map[string]uint64{},
		now:               time.Now,
	}
}

// WithLogger attaches the durable trail. The in-memory figures reset on restart
// by design, so the log is where an incident gets reconstructed afterwards.
// Logging lives here rather than in the services because no service currently
// takes a logger, and threading one through two of them to emit a few fields
// would be a wide change for a narrow purpose.
func (r *Recorder) WithLogger(logger *zap.Logger) *Recorder {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.logger = logger
	return r
}

func (r *Recorder) log() *zap.Logger {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.logger
}

// ObserveDuration records one timing sample. Negative values are dropped: a
// clock that stepped backwards should not skew a percentile.
func (r *Recorder) ObserveDuration(metric string, value time.Duration) {
	if r == nil || metric == "" || value < 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ring, ok := r.durations[metric]
	if !ok {
		ring = &durationRing{}
		r.durations[metric] = ring
	}
	ring.add(value)
}

// ObserveSince is the common case of ObserveDuration at a call site that has a
// start time.
func (r *Recorder) ObserveSince(metric string, start time.Time) {
	if r == nil {
		return
	}
	r.ObserveDuration(metric, r.clock().Sub(start))
}

// RecordProviderResult records one provider call outcome. A nil error is a
// success; anything else is classified into a reason class, and the error
// itself is never retained — see Classify.
func (r *Recorder) RecordProviderResult(provider string, err error) {
	if r == nil || provider == "" {
		return
	}
	now := r.clock()
	r.mu.Lock()
	defer r.mu.Unlock()
	health, ok := r.providers[provider]
	if !ok {
		health = &providerHealth{}
		r.providers[provider] = health
	}
	if err == nil {
		health.lastSuccessAt = now
		health.successCount++
		return
	}
	reason := Classify(err)
	health.lastFailureAt = now
	health.lastReason = reason
	health.failureCount++
	health.failures = appendWithinWindow(health.failures, now, recentFailureWindow)

	// The raw error is logged deliberately. The no-secrets constraint applies to
	// the API response, not to the operator's own server log, which is where a
	// provider outage actually gets diagnosed.
	if r.logger != nil {
		r.logger.Warn("provider call failed",
			zap.String("provider", provider),
			zap.String("reason", string(reason)),
			zap.Error(err),
		)
	}
}

// ChatTiming is one chat request's durations. Zero values mean the stage did not
// run: a conversation-intent answer has no retrieval, and a locally generated
// refusal has no first token from the model.
type ChatTiming struct {
	Retrieval      time.Duration
	FirstToken     time.Duration
	Generation     time.Duration
	Intent         string
	RerankFallback bool
}

// RecordChatTiming writes the durable summary line for one chat request. The
// samples themselves are recorded at their own call sites; this exists so the
// per-request picture survives a restart.
func (r *Recorder) RecordChatTiming(timing ChatTiming) {
	if r == nil {
		return
	}
	logger := r.log()
	if logger == nil {
		return
	}
	fields := []zap.Field{
		zap.String("intent", timing.Intent),
		zap.Duration("generationDuration", timing.Generation),
		zap.Bool("rerankFallback", timing.RerankFallback),
	}
	if timing.Retrieval > 0 {
		fields = append(fields, zap.Duration("retrievalDuration", timing.Retrieval))
	}
	if timing.FirstToken > 0 {
		fields = append(fields, zap.Duration("firstTokenLatency", timing.FirstToken))
	}
	logger.Info("chat answer timing", fields...)
}

// RecordRerankFallback counts a degraded retrieval. The reason is one of the
// repository's own fallback constants, never a provider error string.
func (r *Recorder) RecordRerankFallback(reason string) {
	if r == nil {
		return
	}
	if reason == "" {
		reason = "unknown"
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fallbacks[reason]++
}

// RecordRateLimitTrigger counts a request rejected because its fixed-window
// limit was exhausted. Unknown scopes are ignored to keep the key set bounded
// and to avoid publishing caller-controlled values through diagnostics.
func (r *Recorder) RecordRateLimitTrigger(scope string) {
	if r == nil {
		return
	}
	switch scope {
	case RateLimitScopeLogin, RateLimitScopeChat:
	default:
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rateLimitTriggers[scope]++
}

// RecordEmbeddingCacheResult counts query-embedding cache activity. Hit and
// miss describe lookups; error may describe a failed read or write. Errors are
// distinct from misses because they indicate degraded Redis operation while a
// miss is an expected part of normal traffic.
func (r *Recorder) RecordEmbeddingCacheResult(result string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	switch result {
	case EmbeddingCacheResultHit:
		r.embeddingCacheResult.Hits++
	case EmbeddingCacheResultMiss:
		r.embeddingCacheResult.Misses++
	case EmbeddingCacheResultError:
		r.embeddingCacheResult.Errors++
	}
}

// RecordVectorExactFallback counts a vector search that had to be rerun
// exhaustively because the approximate index scan returned fewer rows than the
// knowledge base could supply. A steady rate means the HNSW scan is losing
// candidates to the knowledge-base and soft-delete filters.
func (r *Recorder) RecordVectorExactFallback() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.vectorExactFallbacks++
}

func (r *Recorder) clock() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

// appendWithinWindow drops timestamps that fell out of the window before
// appending, so the slice stays proportional to the failure rate rather than to
// uptime.
func appendWithinWindow(values []time.Time, now time.Time, window time.Duration) []time.Time {
	cutoff := now.Add(-window)
	kept := values[:0]
	for _, value := range values {
		if value.After(cutoff) {
			kept = append(kept, value)
		}
	}
	return append(kept, now)
}

// DurationStats summarizes one metric's ring. Count is the lifetime total, which
// can exceed the number of samples the percentiles were computed from.
type DurationStats struct {
	Count       uint64
	SampleCount int
	P50         time.Duration
	P95         time.Duration
	Max         time.Duration
}

// ProviderStats is a provider's observed health. Zero times mean the provider
// has not been called since this process started.
type ProviderStats struct {
	LastSuccessAt      time.Time
	LastFailureAt      time.Time
	LastFailureReason  Reason
	SuccessCount       uint64
	FailureCount       uint64
	RecentFailureCount int
}

// EmbeddingCacheStats contains lifetime counts since process start. HitRate is
// derived by the diagnostics service so this value stays an exact integer
// snapshot and callers can choose how to represent an empty denominator.
type EmbeddingCacheStats struct {
	Hits   uint64
	Misses uint64
	Errors uint64
}

// Snapshot is a point-in-time copy. It holds no references into the recorder,
// so callers can read it without holding the lock.
type Snapshot struct {
	Durations            map[string]DurationStats
	Providers            map[string]ProviderStats
	RerankFallbacks      map[string]uint64
	RateLimitTriggers    map[string]uint64
	EmbeddingCacheResult EmbeddingCacheStats
	VectorExactFallbacks uint64
}

// Snapshot returns the current figures. A nil receiver yields empty maps rather
// than nil ones, so callers never have to distinguish "no recorder" from "no
// traffic" before ranging over the result.
func (r *Recorder) Snapshot() Snapshot {
	snapshot := Snapshot{
		Durations:         map[string]DurationStats{},
		Providers:         map[string]ProviderStats{},
		RerankFallbacks:   map[string]uint64{},
		RateLimitTriggers: map[string]uint64{},
	}
	if r == nil {
		return snapshot
	}
	now := r.clock()
	r.mu.Lock()
	defer r.mu.Unlock()
	for metric, ring := range r.durations {
		snapshot.Durations[metric] = summarize(ring)
	}
	for provider, health := range r.providers {
		cutoff := now.Add(-recentFailureWindow)
		recent := 0
		for _, at := range health.failures {
			if at.After(cutoff) {
				recent++
			}
		}
		snapshot.Providers[provider] = ProviderStats{
			LastSuccessAt:      health.lastSuccessAt,
			LastFailureAt:      health.lastFailureAt,
			LastFailureReason:  health.lastReason,
			SuccessCount:       health.successCount,
			FailureCount:       health.failureCount,
			RecentFailureCount: recent,
		}
	}
	for reason, count := range r.fallbacks {
		snapshot.RerankFallbacks[reason] = count
	}
	for scope, count := range r.rateLimitTriggers {
		snapshot.RateLimitTriggers[scope] = count
	}
	snapshot.EmbeddingCacheResult = r.embeddingCacheResult
	snapshot.VectorExactFallbacks = r.vectorExactFallbacks
	return snapshot
}

func summarize(ring *durationRing) DurationStats {
	stats := DurationStats{Count: ring.total, SampleCount: len(ring.samples)}
	if len(ring.samples) == 0 {
		return stats
	}
	sorted := make([]time.Duration, len(ring.samples))
	copy(sorted, ring.samples)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	stats.P50 = percentile(sorted, 50)
	stats.P95 = percentile(sorted, 95)
	stats.Max = sorted[len(sorted)-1]
	return stats
}

// percentile uses nearest-rank on the sorted samples. With a few hundred
// samples an interpolating variant would not change what an operator concludes,
// and nearest-rank always returns a value that was actually observed.
func percentile(sorted []time.Duration, p int) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	rank := (p*len(sorted) + 99) / 100
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

// Logger exposes the logger wired by WithLogger so services that already hold a
// Recorder can report non-metric failures without a second dependency. It is
// nil-safe and returns nil when no logger was configured.
func (r *Recorder) Logger() *zap.Logger {
	if r == nil {
		return nil
	}
	return r.log()
}
