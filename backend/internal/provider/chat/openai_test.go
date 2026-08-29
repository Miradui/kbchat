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
