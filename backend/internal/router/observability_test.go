package router

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	tracing "github.com/uptrace/opentelemetry-go-extra/otelgorm"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	collector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	metricpb "go.opentelemetry.io/proto/otlp/metrics/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
	"google.golang.org/protobuf/proto"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/processor"
	"kbchat/backend/internal/document/splitter"
	"kbchat/backend/internal/job"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/observability"
	embeddingprovider "kbchat/backend/internal/provider/embedding"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/storage"
)

// Real Gin routes, services, repositories, parser, worker and OTLP exporter run
// unchanged. SQLite, the model HTTP service and the collector are external fixtures.
// Gaps: HTTP 200 can contain a failed stream; a restart loses in-memory context;
// provider error bodies and SQL parameters must not escape through telemetry.
func TestObservabilityWorkflow(t *testing.T) {
	ctx := context.Background()
	var mu sync.Mutex
	var spans []*tracepb.Span
	var exportedMetrics []*metricpb.Metric
	var collectorDown atomic.Bool
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if collectorDown.Load() {
			w.WriteHeader(503)
			return
		}
		data, _ := io.ReadAll(r.Body)
		if r.URL.Path == "/v1/metrics" {
			var batch metriccollector.ExportMetricsServiceRequest
			if err := proto.Unmarshal(data, &batch); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			mu.Lock()
			for _, resource := range batch.ResourceMetrics {
				for _, scope := range resource.ScopeMetrics {
					if scope.Scope.Name == "kbchat/backend" {
						exportedMetrics = append(exportedMetrics, scope.Metrics...)
					}
				}
			}
			mu.Unlock()
			if target := os.Getenv("RAG_TEST_OTLP_METRICS_ENDPOINT"); target != "" {
				client := &http.Client{Timeout: 3 * time.Second}
				response, err := client.Post(target, "application/x-protobuf", bytes.NewReader(data))
				if err != nil {
					t.Error(err)
					w.WriteHeader(502)
					return
				}
				_ = response.Body.Close()
				if response.StatusCode != 200 {
					t.Errorf("OTLP metrics receiver status %d", response.StatusCode)
				}
			}
			w.Header().Set("Content-Type", "application/x-protobuf")
			return
		}
		var batch collector.ExportTraceServiceRequest
		if err := proto.Unmarshal(data, &batch); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		for _, resource := range batch.ResourceSpans {
			for _, scope := range resource.ScopeSpans {
				spans = append(spans, scope.Spans...)
			}
		}
		mu.Unlock()
		if target := os.Getenv("RAG_TEST_OTLP_ENDPOINT"); target != "" {
			response, err := http.Post(target, "application/x-protobuf", bytes.NewReader(data))
			if err != nil {
				t.Error(err)
				w.WriteHeader(502)
				return
			}
			_ = response.Body.Close()
			if response.StatusCode != 200 {
				t.Errorf("OTLP receiver status %d", response.StatusCode)
			}
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	t.Cleanup(receiver.Close)
	core, logs := observer.New(zap.InfoLevel)
	log := zap.New(core)
	oldProvider, oldMeter, oldPropagator, oldHandler := otel.GetTracerProvider(), otel.GetMeterProvider(), otel.GetTextMapPropagator(), otel.GetErrorHandler()
	provider, err := observability.InitTelemetry(ctx, config.Config{AppEnv: "test", OTelServiceName: "rag-test", OTelTracesEndpoint: receiver.URL + "/v1/traces", OTelMetricsEndpoint: receiver.URL + "/v1/metrics"}, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = provider.Shutdown(ctx)
		otel.SetTracerProvider(oldProvider)
		otel.SetMeterProvider(oldMeter)
		otel.SetTextMapPropagator(oldPropagator)
		otel.SetErrorHandler(oldHandler)
	})
	var failStream, knowledgeIntent, failEmbedding atomic.Bool
	var propagated atomic.Bool
	modelServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		carrier := propagation.HeaderCarrier(r.Header)
		if carrier.Get("traceparent") != "" {
			propagated.Store(true)
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/embeddings") {
			if failEmbedding.Load() {
				w.WriteHeader(503)
				_, _ = io.WriteString(w, `{"error":{"message":"SECRET_MODEL_BODY"}}`)
				return
			}
			_, _ = io.WriteString(w, `{"data":[{"index":0,"embedding":[1,0,0]}]}`)
			return
		}
		var input struct {
			Stream bool `json:"stream"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"SECRET_ANSWER\"}}]}\n\n")
			w.(http.Flusher).Flush()
			if !failStream.Load() {
				_, _ = io.WriteString(w, "data: [DONE]\n\n")
			}
			return
		}
		intent := "general"
		if knowledgeIntent.Load() {
			intent = "knowledge_base"
		}
		decision := fmt.Sprintf(`{"intent":%q,"standaloneQuery":"SECRET_QUESTION"}`, intent)
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": decision}}}})
	}))
	t.Cleanup(modelServer.Close)
	cfg := config.Config{AppEnv: "test", JWTSecret: "observability-fixture-secret-12345678", JWTExpiresIn: "1h", ChatBaseURL: modelServer.URL, ChatAPIKey: "SECRET_API_KEY", ChatModel: "fixture-chat", EmbeddingBaseURL: modelServer.URL, EmbeddingAPIKey: "SECRET_API_KEY", EmbeddingModel: "fixture-embedding", EmbeddingDimension: 3, UploadDir: t.TempDir(), StorageProvider: "local", MaxUploadSizeMB: 1}
	// A cancelled SQL operation may discard its connection. A file preserves the
	// database when SQLite opens a replacement, just as PostgreSQL would.
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "workflow.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.User{}, &model.KnowledgeBase{}, &model.KnowledgeBaseMember{}, &model.ChatSession{}, &model.ChatSessionKnowledgeBase{}, &model.ChatMessage{}, &model.ModelUsageRecord{}, &model.Document{}, &model.DocumentJob{}, &model.DocumentChunk{}, &model.DocumentUploadReceipt{}, &model.StorageCleanupJob{}, &model.Activity{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Use(tracing.NewPlugin(tracing.WithoutMetrics(), tracing.WithoutQueryVariables())); err != nil {
		t.Fatal(err)
	}
	owner, token := createRouteUser(t, cfg, db, "user")
	kb := model.KnowledgeBase{OwnerID: owner.ID, Name: "Fixture"}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}
	session := model.ChatSession{UserID: owner.ID, KnowledgeBaseID: kb.ID, Title: "Fixture"}
	if err := db.Create(&session).Error; err != nil {
		t.Fatal(err)
	}
	metrics := observability.NewRecorder()
	fileStorage := storage.NewLocalStorage(cfg.UploadDir)
	r := NewWithStorageAndDependencies(cfg, db, log, fileStorage, Dependencies{Metrics: metrics})
	request := func(path, body string, cancelDelta bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("POST", path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		if cancelDelta {
			cancelCtx, cancel := context.WithCancel(req.Context())
			defer cancel()
			r.ServeHTTP(&cancelDeltaWriter{rec, cancel}, req.WithContext(cancelCtx))
		} else {
			r.ServeHTTP(rec, req)
		}
		if len(rec.Header().Get("X-Trace-ID")) != 32 {
			t.Fatalf("missing trace ID: %v", rec.Header())
		}
		return rec
	}
	chatPath := "/api/v1/chat/sessions/" + session.ID.String() + "/messages/stream"
	chat := func(cancel bool) *httptest.ResponseRecorder {
		return request(chatPath, fmt.Sprintf(`{"content":"SECRET_QUESTION","clientRequestId":%q}`, uuid.NewString()), cancel)
	}
	success := chat(false)
	if success.Code != 200 || !strings.Contains(success.Body.String(), "event: done") {
		t.Fatalf("success: %d %s", success.Code, success.Body.String())
	}
	failStream.Store(true)
	failed := chat(false)
	if failed.Code != 200 || !strings.Contains(failed.Body.String(), "event: error") || !strings.Contains(failed.Body.String(), failed.Header().Get("X-Trace-ID")) {
		t.Fatalf("mid-stream failure: %s", failed.Body.String())
	}
	failStream.Store(false)
	cancelled := chat(true)
	if strings.Contains(cancelled.Body.String(), "event: done") {
		t.Fatal("cancelled request completed")
	}
	if metrics.Snapshot().Providers[observability.ProviderChat].FailureCount != 1 {
		t.Fatal("client cancellation counted as a provider outage")
	}
	knowledgeIntent.Store(true)
	failEmbedding.Store(true)
	retrievalFailure := chat(false)
	if retrievalFailure.Code != 500 {
		t.Fatalf("retrieval failure: %d %s", retrievalFailure.Code, retrievalFailure.Body.String())
	}

	upload := request("/api/v1/knowledge-bases/"+kb.ID.String()+"/documents/text", `{"title":"Fixture","content":"SECRET_DOCUMENT","format":"txt"}`, false)
	if upload.Code != 201 {
		t.Fatalf("upload: %d %s", upload.Code, upload.Body.String())
	}
	var storedJob model.DocumentJob
	if err := db.First(&storedJob).Error; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(storedJob.Traceparent, upload.Header().Get("X-Trace-ID")) {
		t.Fatal("enqueue context was not persisted")
	}
	runWorker := func(retryDelay time.Duration, finished func() bool) {
		t.Helper()
		repo := repository.NewDocumentRepository(db)
		proc := processor.NewWithStorage(repo, repository.NewChunkRepository(db), parser.NewConfiguredParser(cfg), splitter.New(splitter.DefaultChunkSize, splitter.DefaultChunkOverlap), embeddingprovider.NewOpenAICompatibleProvider(cfg), fileStorage)
		proc.SetRecorder(metrics)
		worker := job.NewWorkerWithOptions(repo, proc, log, job.Options{Recorder: metrics, Interval: 5 * time.Millisecond, RetryDelay: retryDelay, Concurrency: 1, MaxRetries: 3})
		workerCtx, stop := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() { defer close(done); worker.Start(workerCtx) }()
		defer func() {
			stop()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Error("worker did not stop")
			}
		}()
		deadline := time.Now().Add(3 * time.Second)
		for !finished() {
			if time.Now().After(deadline) {
				t.Fatal("worker did not reach expected state")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	runWorker(time.Hour, func() bool {
		var row model.DocumentJob
		return db.First(&row, "id = ?", storedJob.ID).Error == nil && row.RetryCount == 1 && row.Status == "pending"
	})
	// A new worker loads the persisted parent; no request context remains alive.
	failEmbedding.Store(false)
	if err := db.Model(&storedJob).Update("locked_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	runWorker(time.Millisecond, func() bool {
		var row model.DocumentJob
		if db.First(&row, "id = ?", storedJob.ID).Error != nil || row.Status != "completed" {
			return false
		}
		if err := provider.ForceFlush(ctx); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		defer mu.Unlock()
		for _, span := range spans {
			if span.Name != "document.process" {
				continue
			}
			for _, attr := range span.Attributes {
				if attr.Key == "app.outcome" && attr.Value.GetStringValue() == "completed" {
					return true
				}
			}
		}
		return false
	})
	if err := provider.ForceFlush(ctx); err != nil {
		t.Fatal(err)
	}
	if !propagated.Load() {
		t.Fatal("model HTTP calls lost trace context")
	}
	mu.Lock()
	received := append([]*tracepb.Span(nil), spans...)
	mu.Unlock()
	// Trace membership, final outcomes and parentage are the reviewable contract.
	roots := map[string]string{success.Header().Get("X-Trace-ID"): "completed", failed.Header().Get("X-Trace-ID"): "failed", cancelled.Header().Get("X-Trace-ID"): "cancelled", retrievalFailure.Header().Get("X-Trace-ID"): "failed"}
	names := map[string]bool{}
	attempts := 0
	firstVisible := false
	for _, span := range received {
		names[span.Name] = true
		id := hex.EncodeToString(span.TraceId)
		if len(span.ParentSpanId) == 0 {
			if want, ok := roots[id]; ok {
				outcome := ""
				for _, attr := range span.Attributes {
					if attr.Key == "app.outcome" {
						outcome = attr.Value.GetStringValue()
					}
					if attr.Key == "chat.first_visible_text_ms" {
						firstVisible = true
					}
				}
				if outcome != want {
					t.Fatalf("trace outcome = %q, want %q", outcome, want)
				}
				if want == "failed" && span.Status.GetCode() != tracepb.Status_STATUS_CODE_ERROR {
					t.Fatal("failed HTTP 200 stream has no error status")
				}
				delete(roots, id)
			}
		}
		if span.Name == "document.process" {
			attempts++
			if id != upload.Header().Get("X-Trace-ID") || len(span.ParentSpanId) == 0 {
				t.Fatal("worker lost upload parent after restart")
			}
		}
	}
	if len(roots) != 0 || attempts != 2 || !firstVisible {
		t.Fatalf("missing roots=%d attempts=%d firstVisible=%v", len(roots), attempts, firstVisible)
	}
	for _, name := range []string{"rag.answer", "rag.intent", "model.chat", "model.chat_stream", "rag.retrieval", "rag.query_embedding", "model.embedding", "document.process", "document.parse", "document.chunk", "document.publish", "document.storage_read"} {
		if !names[name] {
			t.Errorf("missing span %s", name)
		}
	}
	data, err := json.Marshal(received)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"SECRET_API_KEY", "SECRET_QUESTION", "SECRET_ANSWER", "SECRET_DOCUMENT", "SECRET_MODEL_BODY", "db.statement", "exception.message"} {
		if bytes.Contains(data, []byte(secret)) {
			t.Errorf("exported private field %s", secret)
		}
	}
	correlated := false
	for _, entry := range logs.All() {
		if entry.ContextMap()["trace_id"] == success.Header().Get("X-Trace-ID") {
			correlated = true
		}
	}
	if !correlated {
		t.Fatal("request trace cannot be found in zap logs")
	}
	mu.Lock()
	metricData := append([]*metricpb.Metric(nil), exportedMetrics...)
	mu.Unlock()
	metricNames := map[string]bool{}
	streamFailureCount := int64(0)
	var embeddingSamples uint64
	for _, m := range metricData {
		metricNames[m.Name] = true
		if m.Name == "rag_http_requests" {
			for _, point := range m.GetSum().GetDataPoints() {
				failed, ok := false, false
				for _, a := range point.Attributes {
					if a.Key == "outcome" && a.Value.GetStringValue() == "failed" {
						failed = true
					}
					if a.Key == "status_class" && a.Value.GetStringValue() == "2xx" {
						ok = true
					}
				}
				if failed && ok {
					streamFailureCount = point.GetAsInt()
				}
			}
		}
		if m.Name == "rag_stage_duration" {
			for _, point := range m.GetHistogram().GetDataPoints() {
				for _, a := range point.Attributes {
					if a.Key == "stage" && a.Value.GetStringValue() == "embedding" {
						embeddingSamples = point.Count
					}
				}
				if len(point.ExplicitBounds) < 10 || point.ExplicitBounds[0] > .01 {
					t.Fatal("histogram uses unsuitable second buckets")
				}
			}
		}
	}
	for _, name := range []string{"rag_http_requests", "rag_http_request_duration", "rag_stage_duration", "rag_provider_calls", "rag_document_job_attempts", "rag_document_job_duration", "rag_document_jobs", "rag_queue_collection_success", "rag_telemetry_heartbeat_unixtime"} {
		if !metricNames[name] {
			t.Errorf("missing metric %s", name)
		}
	}
	if embeddingSamples != 3 {
		t.Fatalf("embedding duration samples=%d, want failed query plus failed/successful ingestion attempts", embeddingSamples)
	}
	if streamFailureCount != 1 {
		t.Fatalf("HTTP 200 stream failures=%d", streamFailureCount)
	}
	metricJSON, _ := json.Marshal(metricData)
	for _, private := range []string{"SECRET_API_KEY", "SECRET_QUESTION", "SECRET_DOCUMENT", "SECRET_MODEL_BODY", session.ID.String(), kb.ID.String()} {
		if bytes.Contains(metricJSON, []byte(private)) {
			t.Errorf("metric labels leaked %s", private)
		}
	}
	if metrics.Snapshot().Durations[observability.MetricChatFirstVisibleText].Count != 2 {
		t.Fatal("first visible text included a cancelled or failed write")
	}
	// An unavailable collector must not change the business result or block it.
	collectorDown.Store(true)
	knowledgeIntent.Store(false)
	unobserved := chat(false)
	if !strings.Contains(unobserved.Body.String(), "event: done") {
		t.Fatal("collector outage affected chat")
	}
	if err := provider.ForceFlush(ctx); err == nil {
		t.Fatal("fixture did not exercise export failure")
	}
	manifest := map[string]any{"failedStageDurationIncluded": true, "metricsExported": true, "streamFailureCounted": streamFailureCount == 1, "metricSensitiveDataExported": false, "streamOutcomes": []string{"completed", "failed", "cancelled"}, "retrievalFailure": true, "workerAttempts": attempts, "workerRestartLinked": true, "logsCorrelated": correlated, "sensitiveDataExported": false, "collectorOutageBusinessCompleted": true}
	spanNames := []string{}
	for name := range names {
		if strings.HasPrefix(name, "rag.") || strings.HasPrefix(name, "model.") || strings.HasPrefix(name, "document.") || name == "chat.persist" {
			spanNames = append(spanNames, name)
		}
	}
	slices.Sort(spanNames)
	manifest["spanNames"] = spanNames
	normalized, _ := json.MarshalIndent(manifest, "", "  ")
	runDir := filepath.Join("testdata", "observability", "runs", "latest")
	if err := os.MkdirAll(runDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runDir, "result.json"), append(normalized, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
	expected, err := os.ReadFile(filepath.Join("testdata", "observability", "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	var want, got map[string]any
	if err := json.Unmarshal(expected, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(normalized, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("observability contract changed:\n%s", normalized)
	}

}

type cancelDeltaWriter struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
}

func (w *cancelDeltaWriter) Write(data []byte) (int, error) {
	n, err := w.ResponseRecorder.Write(data)
	if bytes.Contains(data, []byte("event: delta")) {
		w.cancel()
	}
	return n, err
}
