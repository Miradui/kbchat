package embedding

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	openai "github.com/sashabaranov/go-openai"

	"rag/backend/internal/config"
)

type OpenAICompatibleProvider struct {
	apiKey    string
	model     string
	dimension int
	client    *openai.Client
}

func NewOpenAICompatibleProvider(cfg config.Config) *OpenAICompatibleProvider {
	clientConfig := openai.DefaultConfig(cfg.EmbeddingAPIKey)
	clientConfig.BaseURL = strings.TrimRight(cfg.EmbeddingBaseURL, "/")
	clientConfig.HTTPClient = &http.Client{Timeout: 60 * time.Second}
	return &OpenAICompatibleProvider{
		apiKey:    cfg.EmbeddingAPIKey,
		model:     cfg.EmbeddingModel,
		dimension: cfg.EmbeddingDimension,
		client:    openai.NewClientWithConfig(clientConfig),
	}
}

func (p *OpenAICompatibleProvider) EmbedTexts(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return [][]float32{}, nil
	}
	if p.apiKey == "" {
		return nil, fmt.Errorf("EMBEDDING_API_KEY is required")
	}

	response, err := p.client.CreateEmbeddings(ctx, openai.EmbeddingRequest{
		Model:      openai.EmbeddingModel(p.model),
		Input:      texts,
		Dimensions: p.dimension,
	})
	if err != nil {
		return nil, fmt.Errorf("embedding request failed: %w", err)
	}
	if len(response.Data) != len(texts) {
		return nil, fmt.Errorf("embedding response count mismatch: got %d want %d", len(response.Data), len(texts))
	}

	embeddings := make([][]float32, len(texts))
	seen := make([]bool, len(texts))
	for _, item := range response.Data {
		if item.Index < 0 || item.Index >= len(embeddings) {
			return nil, fmt.Errorf("embedding response index out of range: %d", item.Index)
		}
		if seen[item.Index] {
			return nil, fmt.Errorf("embedding response contains duplicate index: %d", item.Index)
		}
		if len(item.Embedding) != p.dimension {
			return nil, fmt.Errorf("embedding dimension mismatch: got %d want %d", len(item.Embedding), p.dimension)
		}
		seen[item.Index] = true
		embeddings[item.Index] = item.Embedding
	}

	return embeddings, nil
}
