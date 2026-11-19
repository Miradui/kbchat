package httpclient_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	chatcore "kbchat/backend/internal/chat"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/provider/chat"
	"kbchat/backend/internal/provider/embedding"
	"kbchat/backend/internal/provider/rerank"
	"kbchat/backend/internal/provider/title"
	rerankcore "kbchat/backend/internal/rerank"
	titlecore "kbchat/backend/internal/title"
)

func TestProvidersRejectOversizedJSONBeforeDecoding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Include valid responses for all providers plus an untrusted unknown field.
		// A wrong/missing Content-Type must not bypass the blocking response limit.
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, `{"padding":"%s","choices":[{"message":{"content":"answer"}}],"data":[{"index":0,"embedding":[1,2]}],"results":[{"index":0,"relevance_score":0.9}]}`, strings.Repeat("x", 4*1024*1024+1))
	}))
	defer server.Close()
	cfg := config.Config{
		ChatBaseURL: server.URL, ChatAPIKey: "fixture", ChatModel: "fixture",
		EmbeddingBaseURL: server.URL, EmbeddingAPIKey: "fixture", EmbeddingModel: "fixture", EmbeddingDimension: 2,
		RerankBaseURL: server.URL, RerankAPIKey: "fixture", RerankModel: "fixture",
		TitleBaseURL: server.URL, TitleAPIKey: "fixture", TitleModel: "fixture",
	}
	ctx := context.Background()
	for name, call := range map[string]func() error{
		"chat": func() error {
			_, err := chat.NewOpenAICompatibleProvider(cfg).Chat(ctx, []chatcore.Message{{Role: "user", Content: "question"}})
			return err
		},
		"embedding": func() error {
			_, err := embedding.NewOpenAICompatibleProvider(cfg).EmbedTexts(ctx, []string{"text"})
			return err
		},
		"rerank": func() error {
			_, err := rerank.NewOpenAICompatibleProvider(cfg).Rerank(ctx, "question", []rerankcore.Document{{Content: "text"}})
			return err
		},
		"title": func() error {
			_, err := title.NewOpenAICompatibleProvider(cfg).SummarizeTitle(ctx, []titlecore.Message{{Role: "user", Content: "question"}})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			var tooLarge *http.MaxBytesError
			if err := call(); !errors.As(err, &tooLarge) {
				t.Fatalf("expected response size rejection, got %v", err)
			}
		})
	}
}
