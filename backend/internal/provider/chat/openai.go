package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	chatcore "rag/backend/internal/chat"
	"rag/backend/internal/config"
)

type OpenAICompatibleProvider struct {
	baseURL    string
	apiKey     string
	model      string
	httpClient *http.Client
	// streamClient has no overall timeout: a long answer legitimately takes
	// longer than one request budget, and cancellation comes from the request
	// context instead. The header timeout still bounds an unresponsive endpoint.
	streamClient *http.Client
}

func NewOpenAICompatibleProvider(cfg config.Config) *OpenAICompatibleProvider {
	return &OpenAICompatibleProvider{
		baseURL: strings.TrimRight(cfg.ChatBaseURL, "/"),
		apiKey:  cfg.ChatAPIKey,
		model:   cfg.ChatModel,
		httpClient: &http.Client{
			Timeout: 90 * time.Second,
		},
		streamClient: &http.Client{
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				ResponseHeaderTimeout: 60 * time.Second,
			},
		},
	}
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	Stream      bool          `json:"stream,omitempty"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (p *OpenAICompatibleProvider) Chat(ctx context.Context, messages []chatcore.Message) (string, error) {
	if p.apiKey == "" {
		return "", fmt.Errorf("CHAT_API_KEY is required")
	}

	payloadMessages := make([]chatMessage, 0, len(messages))
	for _, message := range messages {
		payloadMessages = append(payloadMessages, chatMessage{
			Role:    message.Role,
			Content: message.Content,
		})
	}

	payload, err := json.Marshal(chatRequest{
		Model:       p.model,
		Messages:    payloadMessages,
		Temperature: 0.2,
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

	var result chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if result.Error != nil && result.Error.Message != "" {
			return "", fmt.Errorf("chat request failed: %s", result.Error.Message)
		}
		return "", fmt.Errorf("chat request failed with status %d", resp.StatusCode)
	}
	if len(result.Choices) == 0 {
		return "", fmt.Errorf("chat response has no choices")
	}

	return result.Choices[0].Message.Content, nil
}

type chatStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// maxStreamLineBytes bounds one SSE line. Providers occasionally emit a large
// first chunk, and bufio's 64 KiB default would fail the whole stream on it.
const maxStreamLineBytes = 1024 * 1024

// ChatStream implements chatcore.StreamingProvider over the OpenAI-compatible
// `stream: true` protocol: a sequence of `data: {json}` lines terminated by
// `data: [DONE]`.
func (p *OpenAICompatibleProvider) ChatStream(
	ctx context.Context,
	messages []chatcore.Message,
	onDelta func(string) error,
) (string, error) {
	if p.apiKey == "" {
		return "", fmt.Errorf("CHAT_API_KEY is required")
	}

	payloadMessages := make([]chatMessage, 0, len(messages))
	for _, message := range messages {
		payloadMessages = append(payloadMessages, chatMessage{
			Role:    message.Role,
			Content: message.Content,
		})
	}

	payload, err := json.Marshal(chatRequest{
		Model:       p.model,
		Messages:    payloadMessages,
		Temperature: 0.2,
		Stream:      true,
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
	req.Header.Set("Accept", "text/event-stream")

	resp, err := p.streamClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Errors arrive as a normal JSON body even when streaming was requested.
		var result chatResponse
		message := ""
		if decodeErr := json.NewDecoder(resp.Body).Decode(&result); decodeErr == nil {
			if result.Error != nil && result.Error.Message != "" {
				message = result.Error.Message
			}
		}
		if streamUnsupported(resp.StatusCode, message) {
			_ = resp.Body.Close()
			return p.blockingFallback(ctx, messages, onDelta)
		}
		if message != "" {
			return "", fmt.Errorf("chat request failed: %s", message)
		}
		return "", fmt.Errorf("chat request failed with status %d", resp.StatusCode)
	}

	// A few OpenAI-compatible services ignore stream=true and return a regular
	// completion JSON with 200. That is a valid non-streaming capability signal,
	// not an incomplete SSE stream, so consume it without issuing a second call.
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "application/json") {
		var result chatResponse
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return "", err
		}
		if result.Error != nil && result.Error.Message != "" {
			return "", fmt.Errorf("chat request failed: %s", result.Error.Message)
		}
		if len(result.Choices) == 0 || result.Choices[0].Message.Content == "" {
			return "", fmt.Errorf("chat response has no choices")
		}
		answer := result.Choices[0].Message.Content
		if onDelta != nil {
			if err := onDelta(answer); err != nil {
				return "", err
			}
		}
		return answer, nil
	}

	var answer strings.Builder
	sawDone := false
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), maxStreamLineBytes)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Blank separators and non-data fields (`event:`, `id:`, `:` comments)
		// carry nothing this protocol uses.
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			sawDone = true
			break
		}

		var chunk chatStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return "", fmt.Errorf("decode chat stream data: %w", err)
		}
		if chunk.Error != nil && chunk.Error.Message != "" {
			return "", fmt.Errorf("chat request failed: %s", chunk.Error.Message)
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.Content == "" {
				continue
			}
			answer.WriteString(choice.Delta.Content)
			if onDelta != nil {
				if err := onDelta(choice.Delta.Content); err != nil {
					return "", err
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	if !sawDone {
		return "", fmt.Errorf("chat stream ended before [DONE]")
	}

	if answer.Len() == 0 {
		return "", fmt.Errorf("chat response has no choices")
	}
	return answer.String(), nil
}

func streamUnsupported(status int, message string) bool {
	if status == http.StatusNotImplemented {
		return true
	}
	if status != http.StatusBadRequest &&
		status != http.StatusMethodNotAllowed &&
		status != http.StatusUnsupportedMediaType &&
		status != http.StatusUnprocessableEntity {
		return false
	}
	message = strings.ToLower(message)
	return strings.Contains(message, "stream") && (strings.Contains(message, "not support") ||
		strings.Contains(message, "unsupported") ||
		strings.Contains(message, "does not support"))
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
