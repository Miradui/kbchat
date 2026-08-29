package title

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"kbchat/backend/internal/config"
	titlecore "kbchat/backend/internal/title"
)

func TestOpenAICompatibleProviderSummarizesTitle(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var request struct {
			Model       string  `json:"model"`
			Temperature float32 `json:"temperature"`
			Messages    []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if request.Model != "title-model" || len(request.Messages) != 1 || request.Messages[0].Content != "报销流程是什么？" {
			t.Fatalf("unexpected request: %#v", request)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": "报销流程"}}},
		})
	}))
	defer server.Close()

	provider := NewOpenAICompatibleProvider(config.Config{
		TitleBaseURL: server.URL,
		TitleAPIKey:  "test-key",
		TitleModel:   "title-model",
	})
	title, err := provider.SummarizeTitle(context.Background(), []titlecore.Message{{
		Role: "user", Content: "报销流程是什么？",
	}})
	if err != nil {
		t.Fatalf("summarize title: %v", err)
	}
	if title != "报销流程" {
		t.Fatalf("unexpected title: %q", title)
	}
}

func TestOpenAICompatibleProviderRejectsMissingTitleAPIKey(t *testing.T) {
	provider := NewOpenAICompatibleProvider(config.Config{TitleBaseURL: "http://unused", TitleModel: "title-model"})
	if _, err := provider.SummarizeTitle(context.Background(), nil); err == nil {
		t.Fatal("expected missing API key error")
	}
}
