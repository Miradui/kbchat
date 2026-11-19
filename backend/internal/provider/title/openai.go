package title

import (
	"context"
	"fmt"
	"go.opentelemetry.io/otel/attribute"
	"kbchat/backend/internal/observability"
	"strings"
	"time"

	openai "github.com/sashabaranov/go-openai"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/provider/httpclient"
	titlecore "kbchat/backend/internal/title"
)

type OpenAICompatibleProvider struct {
	apiKey string
	model  string
	client *openai.Client
}

func NewOpenAICompatibleProvider(cfg config.Config) *OpenAICompatibleProvider {
	clientConfig := openai.DefaultConfig(cfg.TitleAPIKey)
	clientConfig.BaseURL = strings.TrimRight(cfg.TitleBaseURL, "/")
	clientConfig.HTTPClient = httpclient.NewJSONClient(30 * time.Second)
	return &OpenAICompatibleProvider{
		apiKey: cfg.TitleAPIKey,
		model:  cfg.TitleModel,
		client: openai.NewClientWithConfig(clientConfig),
	}
}

func (p *OpenAICompatibleProvider) SummarizeTitle(ctx context.Context, messages []titlecore.Message) (string, error) {
	title, _, err := p.SummarizeTitleWithUsage(ctx, messages)
	return title, err
}

func (p *OpenAICompatibleProvider) SummarizeTitleWithUsage(ctx context.Context, messages []titlecore.Message) (title string, spent titlecore.Usage, retErr error) {
	ctx, span := observability.Start(ctx, "model.title", attribute.String("gen_ai.request.model", p.model))
	defer func() { observability.Finish(span, retErr) }()
	if p.apiKey == "" {
		return "", titlecore.Usage{}, fmt.Errorf("TITLE_API_KEY is required")
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
		return "", titlecore.Usage{}, fmt.Errorf("title request failed: %w", err)
	}
	if len(response.Choices) == 0 {
		return "", titlecore.Usage{}, fmt.Errorf("title response has no choices")
	}
	usage := titlecore.Usage{
		PromptTokens:     response.Usage.PromptTokens,
		CompletionTokens: response.Usage.CompletionTokens,
		TotalTokens:      response.Usage.TotalTokens,
		Model:            p.model,
	}
	// The SDK exposes usage as a value type, so presence cannot be checked
	// directly; a call that really ran accounts for at least one token.
	usage.Reported = usage.PromptTokens > 0 || usage.CompletionTokens > 0 || usage.TotalTokens > 0
	return response.Choices[0].Message.Content, usage, nil
}
