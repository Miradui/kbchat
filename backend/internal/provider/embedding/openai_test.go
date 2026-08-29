package embedding

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kbchat/backend/internal/config"
)

func TestOpenAICompatibleProviderRejectsDuplicateResponseIndex(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"index": 0, "embedding": []float32{1, 2}},
				{"index": 0, "embedding": []float32{3, 4}},
			},
		})
	}))
	defer server.Close()

	provider := NewOpenAICompatibleProvider(config.Config{
		EmbeddingBaseURL:   server.URL,
		EmbeddingAPIKey:    "test-key",
		EmbeddingModel:     "test-embedding",
		EmbeddingDimension: 2,
	})

	_, err := provider.EmbedTexts(context.Background(), []string{"alpha", "bravo"})
	if err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("expected duplicate index error, got %v", err)
	}
}
