package observability

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/config"
)

type Telemetry struct {
	traces  *sdktrace.TracerProvider
	metrics *sdkmetric.MeterProvider
}

func (t *Telemetry) Shutdown(ctx context.Context) error {
	return errors.Join(t.traces.Shutdown(ctx), t.metrics.Shutdown(ctx))
}

func (t *Telemetry) ForceFlush(ctx context.Context) error {
	return errors.Join(t.traces.ForceFlush(ctx), t.metrics.ForceFlush(ctx))
}

// InitTelemetry keeps both exporters off the business path. Metrics are
// independent of trace sampling; empty endpoints retain local correlation only.
func InitTelemetry(ctx context.Context, cfg config.Config, log *zap.Logger) (*Telemetry, error) {
	for name, endpoint := range map[string]string{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": cfg.OTelTracesEndpoint, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": cfg.OTelMetricsEndpoint} {
		if endpoint == "" {
			continue
		}
		u, err := url.Parse(endpoint)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
			return nil, fmt.Errorf("%s must be an absolute HTTP(S) URL without credentials", name)
		}
	}
	if cfg.OTelServiceName == "" {
		cfg.OTelServiceName = "rag-backend"
	}
	res := resource.NewSchemaless(
		attribute.String("service.name", cfg.OTelServiceName),
		attribute.String("service.instance.id", uuid.NewString()),
		attribute.String("deployment.environment.name", cfg.AppEnv),
	)
	opts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	metricOpts := []sdkmetric.Option{sdkmetric.WithResource(res), sdkmetric.WithView(sdkmetric.NewView(sdkmetric.Instrument{Name: "rag_*_duration"}, sdkmetric.Stream{Aggregation: sdkmetric.AggregationExplicitBucketHistogram{Boundaries: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2, 5, 10, 20, 30, 60, 90, 120}}}))}
	if cfg.OTelMetricsEndpoint != "" {
		exporter, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(cfg.OTelMetricsEndpoint), otlpmetrichttp.WithTimeout(3*time.Second), otlpmetrichttp.WithRetry(otlpmetrichttp.RetryConfig{Enabled: false}))
		if err != nil {
			return nil, err
		}
		metricOpts = append(metricOpts, sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(15*time.Second), sdkmetric.WithTimeout(3*time.Second))))
	}
	if cfg.OTelTracesEndpoint != "" {
		exporter, err := otlptracehttp.New(ctx,
			otlptracehttp.WithEndpointURL(cfg.OTelTracesEndpoint),
			otlptracehttp.WithTimeout(3*time.Second),
			otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}),
		)
		if err != nil {
			return nil, err
		}
		opts = append(opts, sdktrace.WithBatcher(privateExporter{exporter},
			sdktrace.WithBatchTimeout(time.Second), sdktrace.WithExportTimeout(3*time.Second)))
	}
	provider := sdktrace.NewTracerProvider(opts...)
	meterProvider := sdkmetric.NewMeterProvider(metricOpts...)
	otel.SetTracerProvider(provider)
	otel.SetMeterProvider(meterProvider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		log.Warn("telemetry export failed", zap.String("reason", string(Classify(err))))
	}))
	return &Telemetry{traces: provider, metrics: meterProvider}, nil
}

func Start(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	return otel.Tracer("kbchat/backend").Start(ctx, name, trace.WithAttributes(attrs...))
}

// Finish records closed error classes rather than raw errors containing prompts,
// model response bodies, connection strings or credentials.
func Finish(span trace.Span, err error) {
	if err != nil {
		outcome := "failed"
		if errors.Is(err, context.Canceled) {
			outcome = "cancelled"
		}
		span.SetAttributes(attribute.String("app.outcome", outcome))
		var appErr *apperror.Error
		if errors.As(err, &appErr) {
			span.SetAttributes(attribute.String("app.error_code", appErr.Code))
		}
		if outcome != "cancelled" {
			span.SetAttributes(attribute.String("error.type", string(Classify(err))))
			span.SetStatus(codes.Error, string(Classify(err)))
		}
	} else {
		span.SetAttributes(attribute.String("app.outcome", "completed"))
	}
	span.End()
}

func TraceID(ctx context.Context) string {
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return ""
	}
	return sc.TraceID().String()
}

func Log(ctx context.Context, log *zap.Logger) *zap.Logger {
	if log == nil {
		return nil
	}
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return log
	}
	return log.With(zap.String("trace_id", sc.TraceID().String()), zap.String("span_id", sc.SpanID().String()))
}

func TraceParent(ctx context.Context) string {
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	return carrier.Get("traceparent")
}

func WithTraceParent(ctx context.Context, parent string) context.Context {
	return propagation.TraceContext{}.Extract(ctx, propagation.MapCarrier{"traceparent": parent})
}
