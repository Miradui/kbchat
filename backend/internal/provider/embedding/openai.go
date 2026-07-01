package embedding

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"rag/backend/internal/config"
)

type OpenAICompatibleProvider struct {
	baseURL    string
	apiKey     string
	model      string
	dimension  int
	httpClient *http.Client
}

func NewOpenAICompatibleProvider(cfg config.Config) *OpenAICompatibleProvider {
	return &OpenAICompatibleProvider{
		baseURL:   strings.TrimRight(cfg.EmbeddingBaseURL, "/"),
		apiKey:    cfg.EmbeddingAPIKey,
		model:     cfg.EmbeddingModel,
		dimension: cfg.EmbeddingDimension,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

type embeddingRequest struct {
	Model      string   `json:"model"`
	Input      []string `json:"input"`
	Dimensions int      `json:"dimensions,omitempty"`
}

type embeddingResponse struct {
	Data []struct {
		Embedding []float32 `json:"embedding"`
		Index     int       `json:"index"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (p *OpenAICompatibleProvider) EmbedTexts(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return [][]float32{}, nil
	}
	if p.apiKey == "" {
		return nil, fmt.Errorf("EMBEDDING_API_KEY is required")
	}

	payload, err := json.Marshal(embeddingRequest{
		Model:      p.model,
		Input:      texts,
		Dimensions: p.dimension,
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/embeddings", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result embeddingResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if result.Error != nil && result.Error.Message != "" {
			return nil, fmt.Errorf("embedding request failed: %s", result.Error.Message)
		}
		return nil, fmt.Errorf("embedding request failed with status %d", resp.StatusCode)
	}
	if len(result.Data) != len(texts) {
		return nil, fmt.Errorf("embedding response count mismatch: got %d want %d", len(result.Data), len(texts))
	}

	embeddings := make([][]float32, len(texts))
	for _, item := range result.Data {
		if item.Index < 0 || item.Index >= len(embeddings) {
			return nil, fmt.Errorf("embedding response index out of range: %d", item.Index)
		}
		if len(item.Embedding) != p.dimension {
			return nil, fmt.Errorf("embedding dimension mismatch: got %d want %d", len(item.Embedding), p.dimension)
		}
		embeddings[item.Index] = item.Embedding
	}

	return embeddings, nil
}
