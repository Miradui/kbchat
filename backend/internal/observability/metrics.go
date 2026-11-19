package observability

import (
	"context"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Resource IDs, raw URLs, queries and errors belong in traces, not metric labels.
type instruments struct {
	stageDuration  metric.Float64Histogram
	httpDuration   metric.Float64Histogram
	jobDuration    metric.Float64Histogram
	requests       metric.Int64Counter
	providers      metric.Int64Counter
	fallbacks      metric.Int64Counter
	rateLimits     metric.Int64Counter
	cache          metric.Int64Counter
	exactFallbacks metric.Int64Counter
	jobs           metric.Int64Counter
}

func newInstruments() instruments {
	meter := otel.Meter("kbchat/backend")
	var m instruments
	// Instrument names/options are constants, with no user input to validate.
	m.stageDuration, _ = meter.Float64Histogram("rag_stage_duration", metric.WithUnit("s"))
	m.httpDuration, _ = meter.Float64Histogram("rag_http_request_duration", metric.WithUnit("s"))
	m.jobDuration, _ = meter.Float64Histogram("rag_document_job_duration", metric.WithUnit("s"))
	m.requests, _ = meter.Int64Counter("rag_http_requests")
	m.providers, _ = meter.Int64Counter("rag_provider_calls")
	m.fallbacks, _ = meter.Int64Counter("rag_rerank_fallbacks")
	m.rateLimits, _ = meter.Int64Counter("rag_rate_limit_triggers")
	m.cache, _ = meter.Int64Counter("rag_embedding_cache_operations")
	m.exactFallbacks, _ = meter.Int64Counter("rag_vector_exact_fallbacks")
	m.jobs, _ = meter.Int64Counter("rag_document_job_attempts")
	return m
}

func (r *Recorder) RecordRequest(ctx context.Context, method, route string, status int, outcome string, elapsed time.Duration) {
	if r == nil {
		return
	}
	switch method {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS":
	default:
		method = "OTHER"
	}
	if route == "" {
		route = "unmatched"
	}
	attrs := metric.WithAttributes(attribute.String("method", method), attribute.String("route", route), attribute.String("status_class", strconv.Itoa(status/100)+"xx"), attribute.String("outcome", outcome))
	r.instruments.requests.Add(ctx, 1, attrs)
	r.instruments.httpDuration.Record(ctx, elapsed.Seconds(), attrs)
}

func (r *Recorder) RecordJobAttempt(ctx context.Context, outcome string, elapsed time.Duration) {
	if r == nil {
		return
	}
	attrs := metric.WithAttributes(attribute.String("outcome", outcome))
	r.instruments.jobs.Add(ctx, 1, attrs)
	r.instruments.jobDuration.Record(ctx, elapsed.Seconds(), attrs)
}
