package dto

import (
	"encoding/json"
	"testing"
)

func TestChunkListResponseIncludesPaginationFieldsWhenEmpty(t *testing.T) {
	payload, err := json.Marshal(ChunkListResponse{Items: []ChunkResponse{}})
	if err != nil {
		t.Fatalf("marshal chunk list response: %v", err)
	}

	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("unmarshal chunk list response: %v", err)
	}
	for _, field := range []string{"total", "page", "pageSize"} {
		if _, ok := body[field]; !ok {
			t.Fatalf("expected %q in empty chunk list response, got %s", field, payload)
		}
	}
}

func TestChatSessionResponseIncludesNullArchivedAt(t *testing.T) {
	payload, err := json.Marshal(ChatSessionResponse{})
	if err != nil {
		t.Fatalf("marshal chat session response: %v", err)
	}

	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("unmarshal chat session response: %v", err)
	}
	archivedAt, ok := body["archivedAt"]
	if !ok {
		t.Fatalf("expected archivedAt in unarchived session response, got %s", payload)
	}
	if string(archivedAt) != "null" {
		t.Fatalf("expected null archivedAt, got %s", archivedAt)
	}
}

func TestSearchResponseIncludesNullRerankFallback(t *testing.T) {
	payload, err := json.Marshal(SearchResponse{Items: []SearchResultResponse{}})
	if err != nil {
		t.Fatalf("marshal search response: %v", err)
	}

	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("unmarshal search response: %v", err)
	}
	fallback, ok := body["rerankFallback"]
	if !ok {
		t.Fatalf("expected rerankFallback in search response, got %s", payload)
	}
	if string(fallback) != "null" {
		t.Fatalf("expected null rerankFallback, got %s", fallback)
	}
}

func TestSystemDiagnosticsResponseIncludesP2Metrics(t *testing.T) {
	payload, err := json.Marshal(SystemDiagnosticsResponse{
		RateLimitTriggers: map[string]uint64{},
		EmbeddingCache:    SystemEmbeddingCacheMetrics{},
	})
	if err != nil {
		t.Fatalf("marshal diagnostics response: %v", err)
	}

	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("unmarshal diagnostics response: %v", err)
	}
	if string(body["rateLimitTriggers"]) != "{}" {
		t.Fatalf("expected an empty rateLimitTriggers object, got %s", body["rateLimitTriggers"])
	}

	var cache map[string]json.RawMessage
	if err := json.Unmarshal(body["embeddingCache"], &cache); err != nil {
		t.Fatalf("unmarshal embeddingCache: %v", err)
	}
	for _, field := range []string{"hits", "misses", "errors", "hitRate"} {
		if _, ok := cache[field]; !ok {
			t.Fatalf("expected %q in embeddingCache, got %s", field, body["embeddingCache"])
		}
	}
	if string(cache["hitRate"]) != "null" {
		t.Fatalf("expected null hitRate without lookups, got %s", cache["hitRate"])
	}
}
