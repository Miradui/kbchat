package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go.opentelemetry.io/otel/attribute"
	"io"
	"kbchat/backend/internal/observability"
	"net/http"
	"strings"
	"sync"
	"time"

	openai "github.com/sashabaranov/go-openai"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	chatcore "kbchat/backend/internal/chat"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/provider/httpclient"
)

type OpenAICompatibleProvider struct {
	baseURL      string
	apiKey       string
	model        string
	client       *openai.Client
	streamClient *http.Client
}

func NewOpenAICompatibleProvider(cfg config.Config) *OpenAICompatibleProvider {
	baseURL := strings.TrimRight(cfg.ChatBaseURL, "/")
	return &OpenAICompatibleProvider{
		baseURL: baseURL,
		apiKey:  cfg.ChatAPIKey,
		model:   cfg.ChatModel,
		client:  newClient(cfg.ChatAPIKey, baseURL, httpclient.NewJSONClient(90*time.Second)),
		streamClient: &http.Client{Transport: otelhttp.NewTransport(&http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			ResponseHeaderTimeout: 60 * time.Second,
		})},
	}
}

func newClient(apiKey, baseURL string, doer openai.HTTPDoer) *openai.Client {
	cfg := openai.DefaultConfig(apiKey)
	cfg.BaseURL = baseURL
	cfg.HTTPClient = doer
	return openai.NewClientWithConfig(cfg)
}

// Kept as a small wire-contract fixture for provider tests that verify stream=true.
type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	Stream      bool          `json:"stream"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (p *OpenAICompatibleProvider) Chat(ctx context.Context, messages []chatcore.Message) (string, error) {
	answer, _, err := p.ChatWithUsage(ctx, messages)
	return answer, err
}

func (p *OpenAICompatibleProvider) ChatWithUsage(ctx context.Context, messages []chatcore.Message) (string, chatcore.Usage, error) {
	return p.ChatWithOptions(ctx, messages, chatcore.Options{})
}

func (p *OpenAICompatibleProvider) ChatWithOptions(ctx context.Context, messages []chatcore.Message, options chatcore.Options) (result string, spent chatcore.Usage, retErr error) {
	ctx, span := observability.Start(ctx, "model.chat", attribute.String("gen_ai.request.model", p.model))
	defer func() { observability.Finish(span, retErr) }()
	if p.apiKey == "" {
		return "", chatcore.Usage{}, fmt.Errorf("CHAT_API_KEY is required")
	}

	model := p.model
	if options.Model != "" {
		model = options.Model
	}
	span.SetAttributes(attribute.String("gen_ai.request.model", model))
	temperature := float32(0.2)
	if options.Temperature != nil {
		temperature = float32(*options.Temperature)
	}
	response, err := p.client.CreateChatCompletion(ctx, openai.ChatCompletionRequest{
		Model:       model,
		Messages:    toOpenAIMessages(messages),
		Temperature: temperature,
	})
	if err != nil {
		return "", chatcore.Usage{}, fmt.Errorf("chat request failed: %w", err)
	}
	if len(response.Choices) == 0 {
		return "", chatcore.Usage{}, fmt.Errorf("chat response has no choices")
	}
	// Usage names the model that was requested, not the one the response echoes:
	// vendors often answer with a canonical alias, and MODEL_PRICING and the
	// CHAT_ALLOWED_MODELS whitelist are keyed by the configured name.
	usage := chatcore.Usage{
		PromptTokens:     response.Usage.PromptTokens,
		CompletionTokens: response.Usage.CompletionTokens,
		TotalTokens:      response.Usage.TotalTokens,
		Model:            model,
	}
	usage.Reported = usageReported(usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens)
	return response.Choices[0].Message.Content, usage, nil
}

// usageReported reports whether an upstream actually accounted for tokens.
//
// The OpenAI-compatible SDK exposes usage as a value in the blocking response
// and as a pointer in the stream, so presence alone cannot be trusted: a
// gateway can send an empty usage object, or none at all, and still answer 200.
// A call that really ran accounts for at least one token.
func usageReported(promptTokens, completionTokens, totalTokens int) bool {
	return promptTokens > 0 || completionTokens > 0 || totalTokens > 0
}

func (p *OpenAICompatibleProvider) ChatStream(
	ctx context.Context,
	messages []chatcore.Message,
	onDelta func(string) error,
) (string, error) {
	answer, _, err := p.ChatStreamWithUsage(ctx, messages, onDelta)
	return answer, err
}

func (p *OpenAICompatibleProvider) ChatStreamWithUsage(
	ctx context.Context,
	messages []chatcore.Message,
	onDelta func(string) error,
) (string, chatcore.Usage, error) {
	return p.ChatStreamWithOptions(ctx, messages, onDelta, chatcore.Options{})
}

func (p *OpenAICompatibleProvider) ChatStreamWithOptions(
	ctx context.Context,
	messages []chatcore.Message,
	onDelta func(string) error,
	options chatcore.Options,
) (result string, spent chatcore.Usage, retErr error) {
	ctx, span := observability.Start(ctx, "model.chat_stream", attribute.String("gen_ai.request.model", p.model))
	span.SetAttributes(attribute.Bool("gen_ai.response.streaming", false))
	defer func() { observability.Finish(span, retErr) }()
	if p.apiKey == "" {
		return "", chatcore.Usage{}, fmt.Errorf("CHAT_API_KEY is required")
	}

	model := p.model
	if options.Model != "" {
		model = options.Model
	}
	span.SetAttributes(attribute.String("gen_ai.request.model", model))
	temperature := float32(0.2)
	if options.Temperature != nil {
		temperature = float32(*options.Temperature)
	}
	tracker := &streamResponseTracker{}
	client := newClient(p.apiKey, p.baseURL, &trackingDoer{client: p.streamClient, tracker: tracker})
	stream, err := client.CreateChatCompletionStream(ctx, openai.ChatCompletionRequest{
		Model:         model,
		Messages:      toOpenAIMessages(messages),
		Temperature:   temperature,
		StreamOptions: &openai.StreamOptions{IncludeUsage: true},
	})
	if err != nil {
		if streamUnsupportedError(err) {
			// Fall back with the same model and temperature: a knowledge base
			// that overrides the model must not be answered by the default one
			// just because the upstream refused to stream.
			answer, usage, fallbackErr := p.ChatWithOptions(ctx, messages, options)
			if fallbackErr == nil && onDelta != nil {
				fallbackErr = onDelta(answer)
			}
			return answer, usage, fallbackErr
		}
		return "", chatcore.Usage{}, fmt.Errorf("chat request failed: %w", err)
	}
	defer stream.Close()

	if tracker.isJSON() {
		_, recvErr := stream.Recv()
		if recvErr != nil && !errors.Is(recvErr, io.EOF) {
			return "", chatcore.Usage{}, fmt.Errorf("decode chat response: %w", recvErr)
		}
		answer, usage, err := emitBlockingJSON(tracker.bodyBytes(), onDelta)
		usage.Model = model
		return answer, usage, err
	}

	span.SetAttributes(attribute.Bool("gen_ai.response.streaming", true))
	var answer strings.Builder
	usage := chatcore.Usage{Model: model}
	for {
		response, recvErr := stream.Recv()
		if errors.Is(recvErr, io.EOF) {
			if !tracker.doneSeen() {
				return "", chatcore.Usage{}, fmt.Errorf("chat stream ended before [DONE]")
			}
			break
		}
		if recvErr != nil {
			return "", chatcore.Usage{}, fmt.Errorf("decode chat stream data: %w", recvErr)
		}
		if response.Usage != nil {
			usage.PromptTokens = response.Usage.PromptTokens
			usage.CompletionTokens = response.Usage.CompletionTokens
			usage.TotalTokens = response.Usage.TotalTokens
		}
		for _, choice := range response.Choices {
			delta := choice.Delta.Content
			if delta == "" {
				continue
			}
			answer.WriteString(delta)
			if onDelta != nil {
				if err := onDelta(delta); err != nil {
					return "", chatcore.Usage{}, err
				}
			}
		}
	}

	if answer.Len() == 0 {
		return "", chatcore.Usage{}, fmt.Errorf("chat response has no choices")
	}
	usage.Reported = usageReported(usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens)
	return answer.String(), usage, nil
}

func toOpenAIMessages(messages []chatcore.Message) []openai.ChatCompletionMessage {
	result := make([]openai.ChatCompletionMessage, 0, len(messages))
	for _, message := range messages {
		result = append(result, openai.ChatCompletionMessage{Role: message.Role, Content: message.Content})
	}
	return result
}

func streamUnsupportedError(err error) bool {
	var apiErr *openai.APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	return streamUnsupported(apiErr.HTTPStatusCode, apiErr.Message)
}

func streamUnsupported(status int, message string) bool {
	if status == http.StatusNotImplemented {
		return true
	}
	if status != http.StatusBadRequest && status != http.StatusMethodNotAllowed &&
		status != http.StatusUnsupportedMediaType && status != http.StatusUnprocessableEntity {
		return false
	}
	message = strings.ToLower(message)
	return strings.Contains(message, "stream") && (strings.Contains(message, "not support") ||
		strings.Contains(message, "unsupported") || strings.Contains(message, "does not support"))
}

func (p *OpenAICompatibleProvider) blockingFallback(
	ctx context.Context,
	messages []chatcore.Message,
	onDelta func(string) error,
) (string, error) {
	answer, err := p.Chat(ctx, messages)
	if err != nil {
		return "", err
	}
	if onDelta != nil {
		if err := onDelta(answer); err != nil {
			return "", err
		}
	}
	return answer, nil
}

// emitBlockingJSON decodes a non-streamed body that arrived on the streaming
// endpoint. Model is deliberately left empty: the caller overwrites it with the
// requested model, because vendors echo a canonical alias that MODEL_PRICING and
// CHAT_ALLOWED_MODELS do not know.
func emitBlockingJSON(body []byte, onDelta func(string) error) (string, chatcore.Usage, error) {
	var response openai.ChatCompletionResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return "", chatcore.Usage{}, fmt.Errorf("decode chat response: %w", err)
	}
	if len(response.Choices) == 0 || response.Choices[0].Message.Content == "" {
		return "", chatcore.Usage{}, fmt.Errorf("chat response has no choices")
	}
	answer := response.Choices[0].Message.Content
	if onDelta != nil {
		if err := onDelta(answer); err != nil {
			return "", chatcore.Usage{}, err
		}
	}
	usage := chatcore.Usage{
		PromptTokens:     response.Usage.PromptTokens,
		CompletionTokens: response.Usage.CompletionTokens,
		TotalTokens:      response.Usage.TotalTokens,
	}
	usage.Reported = usageReported(usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens)
	return answer, usage, nil
}

type trackingDoer struct {
	client  openai.HTTPDoer
	tracker *streamResponseTracker
}

func (d *trackingDoer) Do(req *http.Request) (*http.Response, error) {
	response, err := d.client.Do(req)
	if response == nil {
		return response, err
	}
	d.tracker.setContentType(response.Header.Get("Content-Type"))
	response.Body = &trackingBody{ReadCloser: response.Body, tracker: d.tracker}
	return response, err
}

type trackingBody struct {
	io.ReadCloser
	tracker *streamResponseTracker
}

func (b *trackingBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		if trackErr := b.tracker.observe(p[:n]); trackErr != nil {
			return 0, trackErr
		}
	}
	if err != nil {
		b.tracker.finish()
	}
	return n, err
}

type streamResponseTracker struct {
	mu          sync.Mutex
	contentType string
	lineBuffer  []byte
	sawDone     bool
	body        bytes.Buffer
}

func (t *streamResponseTracker) setContentType(contentType string) {
	t.mu.Lock()
	t.contentType = strings.ToLower(contentType)
	t.mu.Unlock()
}

func (t *streamResponseTracker) observe(chunk []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if strings.Contains(t.contentType, "application/json") {
		if len(chunk) > httpclient.MaxJSONResponseBytes-t.body.Len() {
			return fmt.Errorf("chat JSON response exceeds %d bytes", httpclient.MaxJSONResponseBytes)
		}
		_, _ = t.body.Write(chunk)
		return nil
	}
	for len(chunk) > 0 {
		lineEnd := bytes.IndexByte(chunk, '\n')
		length := len(chunk)
		if lineEnd >= 0 {
			length = lineEnd
		}
		if length > httpclient.MaxJSONResponseBytes-len(t.lineBuffer) {
			return fmt.Errorf("chat stream frame exceeds %d bytes", httpclient.MaxJSONResponseBytes)
		}
		t.lineBuffer = append(t.lineBuffer, chunk[:length]...)
		if lineEnd < 0 {
			break
		}
		t.observeLine(t.lineBuffer)
		t.lineBuffer = t.lineBuffer[:0]
		chunk = chunk[lineEnd+1:]
	}
	return nil
}

func (t *streamResponseTracker) finish() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.lineBuffer) > 0 {
		t.observeLine(t.lineBuffer)
		t.lineBuffer = nil
	}
}

func (t *streamResponseTracker) observeLine(line []byte) {
	line = bytes.TrimSuffix(line, []byte{'\r'})
	if !bytes.HasPrefix(line, []byte("data:")) {
		return
	}
	payload := bytes.TrimSpace(line[len("data:"):])
	if bytes.Equal(payload, []byte("[DONE]")) {
		t.sawDone = true
	}
}

func (t *streamResponseTracker) isJSON() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.Contains(t.contentType, "application/json")
}

func (t *streamResponseTracker) doneSeen() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.sawDone
}

func (t *streamResponseTracker) bodyBytes() []byte {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]byte(nil), t.body.Bytes()...)
}
