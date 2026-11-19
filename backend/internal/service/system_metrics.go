package service

import (
	"context"
	"math"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"

	"kbchat/backend/internal/observability"
)

// RegisterMetrics observes durable queue state via repositories at collection
// time. Failed reads emit collection_success=0 and omit queue values, so a
// dependency outage cannot become a misleading healthy zero.
func (s *SystemService) RegisterMetrics() error {
	meter := otel.Meter("kbchat/backend")
	heartbeat, _ := meter.Int64ObservableGauge("rag_telemetry_heartbeat_unixtime")
	jobs, _ := meter.Int64ObservableGauge("rag_document_jobs")
	age, _ := meter.Float64ObservableGauge("rag_document_oldest_job_age", otelmetric.WithUnit("s"))
	cleanup, _ := meter.Int64ObservableGauge("rag_cleanup_backlog")
	cleanupAge, _ := meter.Float64ObservableGauge("rag_cleanup_oldest_pending_age", otelmetric.WithUnit("s"))
	collected, _ := meter.Int64ObservableGauge("rag_queue_collection_success")
	_, err := meter.RegisterCallback(func(ctx context.Context, observer otelmetric.Observer) error {
		observer.ObserveInt64(heartbeat, time.Now().Unix())
		ctx, cancel := context.WithTimeout(ctx, probeTimeout)
		defer cancel()
		ctx, span := observability.Start(ctx, "system.queue_metrics")
		defer span.End()
		if s.diag.Docs != nil {
			stats, err := s.diag.Docs.QueueStats(ctx, documentFailureWindow)
			ok := int64(0)
			if err == nil {
				ok = 1
				for state, value := range map[string]int64{"pending": stats.Pending, "running": stats.Running, "failed": stats.Failed, "completed": stats.Completed, "cancelled": stats.Cancelled} {
					observer.ObserveInt64(jobs, value, otelmetric.WithAttributes(attribute.String("state", state)))
				}
				for state, at := range map[string]time.Time{"pending": stats.OldestPendingAt, "running": stats.OldestRunningAt} {
					seconds := 0.0
					if !at.IsZero() {
						seconds = math.Max(0, time.Since(at).Seconds())
					}
					observer.ObserveFloat64(age, seconds, otelmetric.WithAttributes(attribute.String("state", state)))
				}
			}
			observer.ObserveInt64(collected, ok, otelmetric.WithAttributes(attribute.String("queue", "documents")))
		}
		if s.diag.Cleanup != nil {
			stats, err := s.diag.Cleanup.QueueStats(ctx)
			ok := int64(0)
			if err == nil {
				ok = 1
				observer.ObserveInt64(cleanup, stats.Backlog)
				seconds := 0.0
				if !stats.OldestEnqueuedAt.IsZero() {
					seconds = math.Max(0, time.Since(stats.OldestEnqueuedAt).Seconds())
				}
				observer.ObserveFloat64(cleanupAge, seconds)
			}
			observer.ObserveInt64(collected, ok, otelmetric.WithAttributes(attribute.String("queue", "cleanup")))
		}
		return nil
	}, heartbeat, jobs, age, cleanup, cleanupAge, collected)
	return err
}
