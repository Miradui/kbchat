package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	chatcore "kbchat/backend/internal/chat"
	"kbchat/backend/internal/config"
)

func newOpenAIStreamTestProvider(serverURL string) *OpenAICompatibleProvider {
	return NewOpenAICompatibleProvider(config.Config{
		ChatBaseURL: serverURL,
		ChatAPIKey:  "test-key",
		ChatModel:   "test-model",
	})
}

func TestChatStreamCompletesOnlyAfterDone(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request chatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if !request.Stream {
			t.Fatal("expected stream=true")
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, ": keep-alive\n\nevent: message\ndata: {\"choices\":[{\"delta\":{\"content\":\"完整\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"回答\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()

	var deltas []string
	answer, err := newOpenAIStreamTestProvider(server.URL).ChatStream(
		context.Background(),
		[]chatcore.Message{{Role: "user", Content: "问题"}},
		func(delta string) error {
			deltas = append(deltas, delta)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("chat stream: %v", err)
	}
	if answer != "完整回答" {
		t.Fatalf("expected complete answer, got %q", answer)
	}
	if strings.Join(deltas, "") != answer {
		t.Fatalf("expected deltas to match answer, got %#v", deltas)
	}
}

func TestChatStreamAcceptsValidDoneWhitespaceVariants(t *testing.T) {
	for _, doneFrame := range []string{
		"data:[DONE]\n\n",
		"data:\t[DONE]\r\n\r\n",
	} {
		doneFrame := doneFrame
		t.Run(fmt.Sprintf("%q", doneFrame), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"完整回答\"}}]}\n\n"+doneFrame)
			}))
			defer server.Close()

			answer, err := newOpenAIStreamTestProvider(server.URL).ChatStream(
				context.Background(),
				[]chatcore.Message{{Role: "user", Content: "问题"}},
				nil,
			)
			if err != nil {
				t.Fatalf("chat stream with valid DONE frame: %v", err)
			}
			if answer != "完整回答" {
				t.Fatalf("expected complete answer, got %q", answer)
			}
		})
	}
}

func TestChatStreamRejectsCleanEOFAfterDeltaWithoutDone(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"半截回答\"}}]}\n\n")
	}))
	defer server.Close()

	var deltas []string
	answer, err := newOpenAIStreamTestProvider(server.URL).ChatStream(
		context.Background(),
		[]chatcore.Message{{Role: "user", Content: "问题"}},
		func(delta string) error {
			deltas = append(deltas, delta)
			return nil
		},
	)
	if err == nil || !strings.Contains(err.Error(), "before [DONE]") {
		t.Fatalf("expected incomplete-stream error, got answer=%q err=%v", answer, err)
	}
	if answer != "" {
		t.Fatalf("an incomplete stream must not return an authoritative answer, got %q", answer)
	}
	if strings.Join(deltas, "") != "半截回答" {
		t.Fatalf("expected the already-received delta to be observable, got %#v", deltas)
	}
}

func TestChatStreamDoesNotTreatDoneTextInsideDeltaAsCompletion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"示例 data: [DONE] 文本\"}}]}\n\n")
	}))
	defer server.Close()

	answer, err := newOpenAIStreamTestProvider(server.URL).ChatStream(
		context.Background(),
		[]chatcore.Message{{Role: "user", Content: "问题"}},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "before [DONE]") {
		t.Fatalf("expected incomplete-stream error, got answer=%q err=%v", answer, err)
	}
}

func TestChatStreamRejectsBrokenConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Length", "4096")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"半截回答\"}}]}\n\n")
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
	}))
	defer server.Close()

	answer, err := newOpenAIStreamTestProvider(server.URL).ChatStream(
		context.Background(),
		[]chatcore.Message{{Role: "user", Content: "问题"}},
		nil,
	)
	if err == nil {
		t.Fatalf("expected a broken connection error, got answer %q", answer)
	}
	if answer != "" {
		t.Fatalf("a broken stream must not return an authoritative answer, got %q", answer)
	}
}

func TestChatStreamRejectsMalformedJSONDataFrame(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"部分\"}}]}\n\ndata: {not-json}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()

	answer, err := newOpenAIStreamTestProvider(server.URL).ChatStream(
		context.Background(),
		[]chatcore.Message{{Role: "user", Content: "问题"}},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "decode chat stream data") {
		t.Fatalf("expected malformed-frame error, got answer=%q err=%v", answer, err)
	}
	if answer != "" {
		t.Fatalf("a malformed stream must not return an authoritative answer, got %q", answer)
	}
}

func TestChatStreamRejectsUpstreamNon2xx(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = fmt.Fprint(w, `{"error":{"message":"provider unavailable"}}`)
	}))
	defer server.Close()

	answer, err := newOpenAIStreamTestProvider(server.URL).ChatStream(
		context.Background(),
		[]chatcore.Message{{Role: "user", Content: "问题"}},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "provider unavailable") {
		t.Fatalf("expected upstream error, got answer=%q err=%v", answer, err)
	}
	if answer != "" {
		t.Fatalf("a failed upstream request must not return an answer, got %q", answer)
	}
}

func TestChatStreamFallsBackWhenUpstreamRejectsStreaming(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var request chatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		if request.Stream {
			w.WriteHeader(http.StatusUnsupportedMediaType)
			_, _ = fmt.Fprint(w, `{"error":{"message":"stream is not supported"}}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"阻塞回退回答"}}]}`)
	}))
	defer server.Close()

	var deltas []string
	answer, err := newOpenAIStreamTestProvider(server.URL).ChatStream(
		context.Background(),
		[]chatcore.Message{{Role: "user", Content: "问题"}},
		func(delta string) error {
			deltas = append(deltas, delta)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("chat stream fallback: %v", err)
	}
	if answer != "阻塞回退回答" || strings.Join(deltas, "") != answer {
		t.Fatalf("unexpected fallback answer=%q deltas=%#v", answer, deltas)
	}
	if requests.Load() != 2 {
		t.Fatalf("expected stream attempt plus blocking fallback, got %d requests", requests.Load())
	}
}

func TestChatStreamAcceptsBlockingJSONFromStreamRequest(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var request chatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if !request.Stream {
			t.Fatal("expected the first request to ask for streaming")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"兼容 JSON 回答"}}]}`)
	}))
	defer server.Close()

	var deltas []string
	answer, err := newOpenAIStreamTestProvider(server.URL).ChatStream(
		context.Background(),
		[]chatcore.Message{{Role: "user", Content: "问题"}},
		func(delta string) error {
			deltas = append(deltas, delta)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("chat stream JSON compatibility: %v", err)
	}
	if answer != "兼容 JSON 回答" || strings.Join(deltas, "") != answer {
		t.Fatalf("unexpected JSON answer=%q deltas=%#v", answer, deltas)
	}
	if requests.Load() != 1 {
		t.Fatalf("expected no second request for an already successful JSON response, got %d", requests.Load())
	}
}

func TestChatStreamFallbackKeepsModelAndTemperatureOverrides(t *testing.T) {
	var models []string
	var temperatures []float32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Model       string  `json:"model"`
			Stream      bool    `json:"stream"`
			Temperature float32 `json:"temperature"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		models = append(models, request.Model)
		temperatures = append(temperatures, request.Temperature)
		w.Header().Set("Content-Type", "application/json")
		if request.Stream {
			w.WriteHeader(http.StatusUnsupportedMediaType)
			_, _ = fmt.Fprint(w, `{"error":{"message":"stream is not supported"}}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"model":"kb-model","choices":[{"message":{"role":"assistant","content":"回退回答"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`)
	}))
	defer server.Close()

	temperature := 0.7
	answer, usage, err := newOpenAIStreamTestProvider(server.URL).ChatStreamWithOptions(
		context.Background(),
		[]chatcore.Message{{Role: "user", Content: "问题"}},
		func(string) error { return nil },
		chatcore.Options{Model: "kb-model", Temperature: &temperature},
	)
	if err != nil {
		t.Fatalf("chat stream fallback: %v", err)
	}
	if answer != "回退回答" || usage.Model != "kb-model" || usage.TotalTokens != 7 {
		t.Fatalf("unexpected fallback answer=%q usage=%#v", answer, usage)
	}
	if len(models) != 2 || models[0] != "kb-model" || models[1] != "kb-model" {
		t.Fatalf("fallback must keep the overriding model on both attempts, got %#v", models)
	}
	if len(temperatures) != 2 || temperatures[1] != 0.7 {
		t.Fatalf("fallback must keep the overriding temperature, got %#v", temperatures)
	}
}

// Vendors often echo a canonical alias ("deepseek-flash") for the requested
// name ("deepseek-v4-flash"). Usage records the requested name because pricing
// and the answer-model whitelist are keyed by it.
func TestUsageReportsTheRequestedModelNotTheEchoedAlias(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Stream bool `json:"stream"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if request.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, "data: {\"model\":\"vendor-alias\",\"choices\":[{\"delta\":{\"content\":\"流式\"}}]}\n\n"+
				"data: {\"model\":\"vendor-alias\",\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n\ndata: [DONE]\n\n")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"model":"vendor-alias","choices":[{"message":{"role":"assistant","content":"回答"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`)
	}))
	defer server.Close()
	provider := newOpenAIStreamTestProvider(server.URL)

	_, usage, err := provider.ChatWithOptions(context.Background(), []chatcore.Message{{Role: "user", Content: "问题"}}, chatcore.Options{Model: "kb-model"})
	if err != nil || usage.Model != "kb-model" || usage.TotalTokens != 7 {
		t.Fatalf("blocking usage=%#v err=%v", usage, err)
	}
	_, usage, err = provider.ChatWithUsage(context.Background(), []chatcore.Message{{Role: "user", Content: "问题"}})
	if err != nil || usage.Model != provider.model {
		t.Fatalf("default model usage=%#v err=%v, want %q", usage, err, provider.model)
	}
	_, usage, err = provider.ChatStreamWithOptions(context.Background(), []chatcore.Message{{Role: "user", Content: "问题"}}, func(string) error { return nil }, chatcore.Options{Model: "kb-model"})
	if err != nil || usage.Model != "kb-model" || usage.TotalTokens != 4 {
		t.Fatalf("stream usage=%#v err=%v", usage, err)
	}
}
