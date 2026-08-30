package observability

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestRecorderNilReceiverIsSafe(t *testing.T) {
	var recorder *Recorder

	// Instrumented call paths are constructed without a recorder in existing
	// tests, so every method has to tolerate a nil receiver rather than forcing
	// those constructors to change.
	recorder.ObserveDuration(MetricRetrieval, time.Second)
	recorder.ObserveSince(MetricRetrieval, time.Now())
	recorder.RecordProviderResult(ProviderChat, errors.New("boom"))
	recorder.RecordRerankFallback("provider_unavailable")

	snapshot := recorder.Snapshot()
	if snapshot.Durations == nil || snapshot.Providers == nil || snapshot.RerankFallbacks == nil {
		t.Fatalf("nil recorder must return empty maps, got %#v", snapshot)
	}
	if len(snapshot.Durations) != 0 || len(snapshot.Providers) != 0 || len(snapshot.RerankFallbacks) != 0 {
		t.Fatalf("nil recorder must report nothing, got %#v", snapshot)
	}
}

func TestRecorderPercentilesOnKnownDistribution(t *testing.T) {
	recorder := NewRecorder()
	for i := 1; i <= 100; i++ {
		recorder.ObserveDuration(MetricRetrieval, time.Duration(i)*time.Millisecond)
	}

	stats := recorder.Snapshot().Durations[MetricRetrieval]
	if stats.Count != 100 || stats.SampleCount != 100 {
		t.Fatalf("unexpected counts: %#v", stats)
	}
	if stats.P50 != 50*time.Millisecond {
		t.Fatalf("p50 = %v, want 50ms", stats.P50)
	}
	if stats.P95 != 95*time.Millisecond {
		t.Fatalf("p95 = %v, want 95ms", stats.P95)
	}
	if stats.Max != 100*time.Millisecond {
		t.Fatalf("max = %v, want 100ms", stats.Max)
	}
}

func TestRecorderRingEvictsOldestSamplesButKeepsLifetimeCount(t *testing.T) {
	recorder := NewRecorder()
	// Fill past capacity with a low value, then push capacity worth of a high
	// value. If eviction works, no low sample survives to move the percentiles.
	for i := 0; i < sampleCapacity; i++ {
		recorder.ObserveDuration(MetricChatGeneration, time.Millisecond)
	}
	for i := 0; i < sampleCapacity; i++ {
		recorder.ObserveDuration(MetricChatGeneration, time.Second)
	}

	stats := recorder.Snapshot().Durations[MetricChatGeneration]
	if stats.SampleCount != sampleCapacity {
		t.Fatalf("sample count = %d, want %d", stats.SampleCount, sampleCapacity)
	}
	if stats.Count != uint64(2*sampleCapacity) {
		t.Fatalf("lifetime count = %d, want %d", stats.Count, 2*sampleCapacity)
	}
	if stats.P50 != time.Second {
		t.Fatalf("p50 = %v, want 1s: old samples were not evicted", stats.P50)
	}
}

func TestRecorderDropsNegativeSamples(t *testing.T) {
	recorder := NewRecorder()
	recorder.ObserveDuration(MetricRerank, -time.Second)

	if stats, ok := recorder.Snapshot().Durations[MetricRerank]; ok {
		t.Fatalf("negative sample was recorded: %#v", stats)
	}
}

func TestRecorderProviderHealthTracksLastOutcomeAndReason(t *testing.T) {
	recorder := NewRecorder()
	recorder.RecordProviderResult(ProviderChat, nil)
	recorder.RecordProviderResult(ProviderChat, &fakeStatusError{message: "unauthorized", status: 401})

	stats := recorder.Snapshot().Providers[ProviderChat]
	if stats.SuccessCount != 1 || stats.FailureCount != 1 {
		t.Fatalf("unexpected provider counts: %#v", stats)
	}
	if stats.LastFailureReason != ReasonAuthRejected {
		t.Fatalf("last failure reason = %q, want %q", stats.LastFailureReason, ReasonAuthRejected)
	}
	if stats.LastSuccessAt.IsZero() || stats.LastFailureAt.IsZero() {
		t.Fatalf("timestamps not recorded: %#v", stats)
	}
	if stats.RecentFailureCount != 1 {
		t.Fatalf("recent failure count = %d, want 1", stats.RecentFailureCount)
	}
}

func TestRecorderRecentFailureCountExcludesOldFailures(t *testing.T) {
	recorder := NewRecorder()
	current := time.Now()
	recorder.now = func() time.Time { return current }

	recorder.RecordProviderResult(ProviderEmbedding, errors.New("boom"))
	// Move past the window: the failure is still in the lifetime total but must
	// stop making a currently healthy provider look broken.
	current = current.Add(recentFailureWindow + time.Minute)

	stats := recorder.Snapshot().Providers[ProviderEmbedding]
	if stats.FailureCount != 1 {
		t.Fatalf("lifetime failure count = %d, want 1", stats.FailureCount)
	}
	if stats.RecentFailureCount != 0 {
		t.Fatalf("recent failure count = %d, want 0", stats.RecentFailureCount)
	}
}

func TestRecorderCountsRerankFallbacksByReason(t *testing.T) {
	recorder := NewRecorder()
	recorder.RecordRerankFallback("provider_unavailable")
	recorder.RecordRerankFallback("provider_unavailable")
	recorder.RecordRerankFallback("")

	fallbacks := recorder.Snapshot().RerankFallbacks
	if fallbacks["provider_unavailable"] != 2 {
		t.Fatalf("provider_unavailable = %d, want 2", fallbacks["provider_unavailable"])
	}
	if fallbacks["unknown"] != 1 {
		t.Fatalf("empty reason must be recorded as unknown, got %#v", fallbacks)
	}
}

// TestRecorderIsSafeForConcurrentUse is meaningful under -race, which the
// verification step runs. The chat and retrieval paths record from many
// in-flight requests at once.
func TestRecorderIsSafeForConcurrentUse(t *testing.T) {
	recorder := NewRecorder()
	var waitGroup sync.WaitGroup
	const workers = 16
	const perWorker = 100

	for i := 0; i < workers; i++ {
		waitGroup.Add(1)
		go func(worker int) {
			defer waitGroup.Done()
			for j := 0; j < perWorker; j++ {
				recorder.ObserveDuration(MetricRetrieval, time.Duration(j)*time.Millisecond)
				recorder.RecordProviderResult(ProviderChat, nil)
				recorder.RecordRerankFallback("provider_unavailable")
				recorder.Snapshot()
			}
		}(i)
	}
	waitGroup.Wait()

	snapshot := recorder.Snapshot()
	if snapshot.Durations[MetricRetrieval].Count != uint64(workers*perWorker) {
		t.Fatalf("lost samples: %#v", snapshot.Durations[MetricRetrieval])
	}
	if snapshot.Providers[ProviderChat].SuccessCount != uint64(workers*perWorker) {
		t.Fatalf("lost provider results: %#v", snapshot.Providers[ProviderChat])
	}
}

func TestRecorderObserveSinceUsesInjectedClock(t *testing.T) {
	recorder := NewRecorder()
	start := time.Now()
	recorder.now = func() time.Time { return start.Add(250 * time.Millisecond) }

	recorder.ObserveSince(MetricChatFirstToken, start)

	stats := recorder.Snapshot().Durations[MetricChatFirstToken]
	if stats.Max != 250*time.Millisecond {
		t.Fatalf("max = %v, want 250ms", stats.Max)
	}
}
