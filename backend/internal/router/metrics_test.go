package router

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"go.opentelemetry.io/otel"
	collector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	metricpb "go.opentelemetry.io/proto/otlp/metrics/v1"
	"go.uber.org/zap"
	"google.golang.org/protobuf/proto"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/storage"
)

// Gaps: sampling must not change counters; raw methods/paths must not become
// labels; an unavailable database must not publish a healthy empty queue.
func TestMetricsSurviveDisabledTracingAndQueueReadFailure(t *testing.T) {
	t.Setenv("OTEL_TRACES_SAMPLER", "always_off")
	ctx := context.Background()
	var mu sync.Mutex
	var last []*metricpb.Metric
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		var batch collector.ExportMetricsServiceRequest
		if err := proto.Unmarshal(data, &batch); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		last = nil
		for _, res := range batch.ResourceMetrics {
			for _, scope := range res.ScopeMetrics {
				if scope.Scope.Name == "kbchat/backend" {
					last = append(last, scope.Metrics...)
				}
			}
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	t.Cleanup(receiver.Close)
	oldProvider, oldMeter, oldPropagator, oldHandler := otel.GetTracerProvider(), otel.GetMeterProvider(), otel.GetTextMapPropagator(), otel.GetErrorHandler()
	telemetry, err := observability.InitTelemetry(ctx, config.Config{AppEnv: "test", OTelMetricsEndpoint: receiver.URL + "/v1/metrics"}, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = telemetry.Shutdown(ctx)
		otel.SetTracerProvider(oldProvider)
		otel.SetMeterProvider(oldMeter)
		otel.SetTextMapPropagator(oldPropagator)
		otel.SetErrorHandler(oldHandler)
	})
	db := testDB(t)
	if err := db.AutoMigrate(&model.DocumentJob{}, &model.StorageCleanupJob{}); err != nil {
		t.Fatal(err)
	}
	r := NewWithStorageAndDependencies(config.Config{AppEnv: "test"}, db, zap.NewNop(), storage.NewLocalStorage(t.TempDir()), Dependencies{})
	for _, path := range []string{"/api/v1/auth/login?private=SECRET_QUERY", "/private/SECRET_PATH"} {
		method := "POST"
		if strings.Contains(path, "SECRET_PATH") {
			method = "SECRET_METHOD"
		}
		req := httptest.NewRequest(method, path, strings.NewReader("{"))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if len(rec.Header().Get("X-Trace-ID")) != 32 {
			t.Fatal("sampling disabled correlation IDs")
		}
	}
	if err := telemetry.ForceFlush(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	first := append([]*metricpb.Metric(nil), last...)
	mu.Unlock()
	requests := int64(0)
	healthy := false
	for _, m := range first {
		if m.Name == "rag_http_requests" {
			for _, point := range m.GetSum().GetDataPoints() {
				requests += point.GetAsInt()
			}
		}
		if m.Name == "rag_queue_collection_success" {
			for _, point := range m.GetGauge().GetDataPoints() {
				if point.GetAsInt() == 1 {
					healthy = true
				}
			}
		}
	}
	if requests != 2 || !healthy {
		t.Fatalf("requests=%d healthy=%v with tracing off", requests, healthy)
	}
	if err := db.Migrator().DropTable(&model.DocumentJob{}); err != nil {
		t.Fatal(err)
	}
	if err := telemetry.ForceFlush(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	second := append([]*metricpb.Metric(nil), last...)
	mu.Unlock()
	failedRead := false
	for _, m := range second {
		if m.Name == "rag_document_jobs" && len(m.GetGauge().GetDataPoints()) > 0 {
			t.Fatal("failed queue read retained healthy values")
		}
		if m.Name == "rag_queue_collection_success" {
			for _, point := range m.GetGauge().GetDataPoints() {
				for _, a := range point.Attributes {
					if a.Key == "queue" && a.Value.GetStringValue() == "documents" && point.GetAsInt() == 0 {
						failedRead = true
					}
				}
			}
		}
	}
	if !failedRead {
		t.Fatal("queue read failure missing")
	}
	data, _ := json.Marshal(second)
	for _, secret := range []string{"SECRET_QUERY", "SECRET_PATH", "SECRET_METHOD"} {
		if strings.Contains(string(data), secret) {
			t.Errorf("unbounded private label: %s", secret)
		}
	}
	dir := filepath.Join("testdata", "observability", "runs", "latest")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	result, _ := json.MarshalIndent(map[string]any{"requestsWithTracingOff": requests, "queueReadFailureReported": failedRead, "failedReadPublishesNoQueueValues": true, "privateLabelsExported": false}, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "metrics.json"), append(result, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
}
