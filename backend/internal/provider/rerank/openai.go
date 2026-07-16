package rerank

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"rag/backend/internal/config"
	corererank "rag/backend/internal/rerank"
)

type OpenAICompatibleProvider struct {
	baseURL    string
	apiKey     string
	model      string
	httpClient *http.Client
}

func NewOpenAICompatibleProvider(cfg config.Config) *OpenAICompatibleProvider {
	return &OpenAICompatibleProvider{
		baseURL: strings.TrimRight(cfg.RerankBaseURL, "/"),
		apiKey:  cfg.RerankAPIKey,
		model:   cfg.RerankModel,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

type rerankRequest struct {
	Model     string   `json:"model"`
	Query     string   `json:"query"`
	Documents []string `json:"documents"`
}

type rerankResponse struct {
	Results []rerankResponseResult `json:"results"`
	Error   *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type rerankResponseResult struct {
	Index          int      `json:"index"`
	RelevanceScore *float64 `json:"relevance_score,omitempty"`
	Score          *float64 `json:"score,omitempty"`
}

func (p *OpenAICompatibleProvider) Rerank(ctx context.Context, query string, documents []corererank.Document) ([]corererank.Result, error) {
	if len(documents) == 0 {
		return []corererank.Result{}, nil
	}
	if p.apiKey == "" {
		return nil, fmt.Errorf("RERANK_API_KEY is required")
	}

	contents := make([]string, 0, len(documents))
	for _, document := range documents {
		contents = append(contents, document.Content)
	}

	payload, err := json.Marshal(rerankRequest{
		Model:     p.model,
		Query:     query,
		Documents: contents,
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/rerank", bytes.NewReader(payload))
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

	var result rerankResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if result.Error != nil && result.Error.Message != "" {
			return nil, fmt.Errorf("rerank request failed: %s", result.Error.Message)
		}
		return nil, fmt.Errorf("rerank request failed with status %d", resp.StatusCode)
	}
	if len(result.Results) == 0 {
		return nil, fmt.Errorf("rerank response has no results")
	}

	reranked := make([]corererank.Result, 0, len(result.Results))
	for _, item := range result.Results {
		if item.Index < 0 || item.Index >= len(documents) {
			return nil, fmt.Errorf("rerank response index out of range: %d", item.Index)
		}
		score, ok := item.score()
		if !ok {
			return nil, fmt.Errorf("rerank response missing score for index %d", item.Index)
		}
		reranked = append(reranked, corererank.Result{
			ID:    documents[item.Index].ID,
			Score: score,
		})
	}

	return reranked, nil
}

func (r rerankResponseResult) score() (float64, bool) {
	if r.RelevanceScore != nil {
		return *r.RelevanceScore, true
	}
	if r.Score != nil {
		return *r.Score, true
	}
	return 0, false
}
