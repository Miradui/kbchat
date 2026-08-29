package rerank

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"kbchat/backend/internal/config"
	corererank "kbchat/backend/internal/rerank"
)

func TestOpenAICompatibleProviderRerankPostsDocumentsAndMapsScores(t *testing.T) {
	var gotRequest struct {
		Model     string   `json:"model"`
		Query     string   `json:"query"`
		Documents []string `json:"documents"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/rerank" {
			t.Fatalf("expected /v1/rerank path, got %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("missing bearer token: %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&gotRequest); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"index": 1, "relevance_score": 0.92},
				{"index": 0, "relevance_score": 0.51},
			},
		})
	}))
	defer server.Close()

	provider := NewOpenAICompatibleProvider(config.Config{
		RerankBaseURL: server.URL + "/v1",
		RerankAPIKey:  "test-key",
		RerankModel:   "test-rerank",
	})

	results, err := provider.Rerank(context.Background(), "expense policy", []corererank.Document{
		{ID: "chunk-a", Content: "alpha"},
		{ID: "chunk-b", Content: "bravo"},
	})
	if err != nil {
		t.Fatalf("Rerank returned error: %v", err)
	}

	if gotRequest.Model != "test-rerank" {
		t.Fatalf("expected model test-rerank, got %s", gotRequest.Model)
	}
	if gotRequest.Query != "expense policy" {
		t.Fatalf("expected query to be sent, got %q", gotRequest.Query)
	}
	if len(gotRequest.Documents) != 2 || gotRequest.Documents[0] != "alpha" || gotRequest.Documents[1] != "bravo" {
		t.Fatalf("unexpected documents payload: %#v", gotRequest.Documents)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if results[0].ID != "chunk-b" || results[0].Score != 0.92 {
		t.Fatalf("unexpected first result: %#v", results[0])
	}
	if results[1].ID != "chunk-a" || results[1].Score != 0.51 {
		t.Fatalf("unexpected second result: %#v", results[1])
	}
}

func TestOpenAICompatibleProviderRerankRejectsInvalidResultIndex(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"index": 3, "relevance_score": 0.92},
			},
		})
	}))
	defer server.Close()

	provider := NewOpenAICompatibleProvider(config.Config{
		RerankBaseURL: server.URL,
		RerankAPIKey:  "test-key",
		RerankModel:   "test-rerank",
	})

	_, err := provider.Rerank(context.Background(), "expense policy", []corererank.Document{
		{ID: "chunk-a", Content: "alpha"},
	})
	if err == nil {
		t.Fatal("expected error")
	}
}
