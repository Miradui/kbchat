package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	openai "github.com/sashabaranov/go-openai"

	chatcore "kbchat/backend/internal/chat"
	"kbchat/backend/internal/config"
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
	httpClient := &http.Client{Timeout: 90 * time.Second}
	return &OpenAICompatibleProvider{
		baseURL: baseURL,
		apiKey:  cfg.ChatAPIKey,
		model:   cfg.ChatModel,
		client:  newClient(cfg.ChatAPIKey, baseURL, httpClient),
		streamClient: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			ResponseHeaderTimeout: 60 * time.Second,
		}},
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

func (p *OpenAICompatibleProvider) ChatWithOptions(ctx context.Context, messages []chatcore.Message, options chatcore.Options) (string, chatcore.Usage, error) {
	if p.apiKey == "" {
		return "", chatcore.Usage{}, fmt.Errorf("CHAT_API_KEY is required")
	}

	model := p.model
	if options.Model != "" {
		model = options.Model
	}
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
	return response.Choices[0].Message.Content, chatcore.Usage{PromptTokens: response.Usage.PromptTokens, CompletionTokens: response.Usage.CompletionTokens, TotalTokens: response.Usage.TotalTokens, Model: response.Model}, nil
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
) (string, chatcore.Usage, error) {
	if p.apiKey == "" {
		return "", chatcore.Usage{}, fmt.Errorf("CHAT_API_KEY is required")
	}

	model := p.model
	if options.Model != "" {
		model = options.Model
	}
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
			answer, usage, fallbackErr := p.ChatWithUsage(ctx, messages)
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
		return emitBlockingJSON(tracker.bodyBytes(), onDelta)
	}

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
		if response.Model != "" {
			usage.Model = response.Model
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
	return answer, chatcore.Usage{PromptTokens: response.Usage.PromptTokens, CompletionTokens: response.Usage.CompletionTokens, TotalTokens: response.Usage.TotalTokens, Model: response.Model}, nil
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
		b.tracker.observe(p[:n])
	}
	if err != nil {
		b.tracker.finish()
	}
	return n, err
}

const maxCapturedJSONBytes = 4 * 1024 * 1024

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

func (t *streamResponseTracker) observe(chunk []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if strings.Contains(t.contentType, "application/json") && t.body.Len() < maxCapturedJSONBytes {
		remaining := maxCapturedJSONBytes - t.body.Len()
		if len(chunk) > remaining {
			chunk = chunk[:remaining]
		}
		_, _ = t.body.Write(chunk)
	}
	t.lineBuffer = append(t.lineBuffer, chunk...)
	for {
		lineEnd := bytes.IndexByte(t.lineBuffer, '\n')
		if lineEnd < 0 {
			break
		}
		t.observeLine(t.lineBuffer[:lineEnd])
		t.lineBuffer = t.lineBuffer[lineEnd+1:]
	}
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
