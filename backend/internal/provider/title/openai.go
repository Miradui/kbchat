package title

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"rag/backend/internal/config"
	titlecore "rag/backend/internal/title"
)

type OpenAICompatibleProvider struct {
	baseURL    string
	apiKey     string
	model      string
	httpClient *http.Client
}

func NewOpenAICompatibleProvider(cfg config.Config) *OpenAICompatibleProvider {
	return &OpenAICompatibleProvider{
		baseURL: strings.TrimRight(cfg.TitleBaseURL, "/"),
		apiKey:  cfg.TitleAPIKey,
		model:   cfg.TitleModel,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

type titleRequest struct {
	Model       string         `json:"model"`
	Messages    []titleMessage `json:"messages"`
	Temperature float64        `json:"temperature"`
}

type titleMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type titleResponse struct {
	Choices []struct {
		Message titleMessage `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (p *OpenAICompatibleProvider) SummarizeTitle(ctx context.Context, messages []titlecore.Message) (string, error) {
	if p.apiKey == "" {
		return "", fmt.Errorf("TITLE_API_KEY is required")
	}

	payloadMessages := make([]titleMessage, 0, len(messages))
	for _, message := range messages {
		payloadMessages = append(payloadMessages, titleMessage{
			Role:    message.Role,
			Content: message.Content,
		})
	}

	payload, err := json.Marshal(titleRequest{
		Model:       p.model,
		Messages:    payloadMessages,
		Temperature: 0.1,
	})
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result titleResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if result.Error != nil && result.Error.Message != "" {
			return "", fmt.Errorf("title request failed: %s", result.Error.Message)
		}
		return "", fmt.Errorf("title request failed with status %d", resp.StatusCode)
	}
	if len(result.Choices) == 0 {
		return "", fmt.Errorf("title response has no choices")
	}

	return result.Choices[0].Message.Content, nil
}
