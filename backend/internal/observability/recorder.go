// Package observability collects per-process request timings and dependency
// outcomes for the diagnostics endpoint.
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
)

// Metric names recorded by the chat and retrieval paths. They are exported so
// the call sites and the diagnostics service cannot drift on spelling.
const (
	MetricRetrieval      = "retrieval"
	MetricEmbedding      = "embedding"
	MetricRerank         = "rerank"
	MetricChatFirstToken = "chat_first_token"
	MetricChatGeneration = "chat_generation"
)

// Provider names used with RecordProviderResult.
const (
	ProviderChat      = "chat"
	ProviderEmbedding = "embedding"
	ProviderRerank    = "rerank"
	ProviderTitle     = "title"
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
	mu        sync.Mutex
	durations map[string]*durationRing
	providers map[string]*providerHealth
	fallbacks map[string]uint64
	now       func() time.Time
}

func NewRecorder() *Recorder {
	return &Recorder{
		durations: map[string]*durationRing{},
		providers: map[string]*providerHealth{},
		fallbacks: map[string]uint64{},
		now:       time.Now,
	}
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
	health.lastFailureAt = now
	health.lastReason = Classify(err)
	health.failureCount++
	health.failures = appendWithinWindow(health.failures, now, recentFailureWindow)
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

// Snapshot is a point-in-time copy. It holds no references into the recorder,
// so callers can read it without holding the lock.
type Snapshot struct {
	Durations       map[string]DurationStats
	Providers       map[string]ProviderStats
	RerankFallbacks map[string]uint64
}

// Snapshot returns the current figures. A nil receiver yields empty maps rather
// than nil ones, so callers never have to distinguish "no recorder" from "no
// traffic" before ranging over the result.
func (r *Recorder) Snapshot() Snapshot {
	snapshot := Snapshot{
		Durations:       map[string]DurationStats{},
		Providers:       map[string]ProviderStats{},
		RerankFallbacks: map[string]uint64{},
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
