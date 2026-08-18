package title

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	openai "github.com/sashabaranov/go-openai"

	"rag/backend/internal/config"
	titlecore "rag/backend/internal/title"
)

type OpenAICompatibleProvider struct {
	apiKey string
	model  string
	client *openai.Client
}

func NewOpenAICompatibleProvider(cfg config.Config) *OpenAICompatibleProvider {
	clientConfig := openai.DefaultConfig(cfg.TitleAPIKey)
	clientConfig.BaseURL = strings.TrimRight(cfg.TitleBaseURL, "/")
	clientConfig.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	return &OpenAICompatibleProvider{
		apiKey: cfg.TitleAPIKey,
		model:  cfg.TitleModel,
		client: openai.NewClientWithConfig(clientConfig),
	}
}

func (p *OpenAICompatibleProvider) SummarizeTitle(ctx context.Context, messages []titlecore.Message) (string, error) {
	if p.apiKey == "" {
		return "", fmt.Errorf("TITLE_API_KEY is required")
	}

	payloadMessages := make([]openai.ChatCompletionMessage, 0, len(messages))
	for _, message := range messages {
		payloadMessages = append(payloadMessages, openai.ChatCompletionMessage{
			Role:    message.Role,
			Content: message.Content,
		})
	}
	response, err := p.client.CreateChatCompletion(ctx, openai.ChatCompletionRequest{
		Model:       p.model,
		Messages:    payloadMessages,
		Temperature: 0.1,
	})
	if err != nil {
		return "", fmt.Errorf("title request failed: %w", err)
	}
	if len(response.Choices) == 0 {
		return "", fmt.Errorf("title response has no choices")
	}
	return response.Choices[0].Message.Content, nil
}
