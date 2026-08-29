package handler

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
)

// The SSE framing is a wire contract the frontend parser depends on, so it is
// pinned here rather than left to the streaming service tests, which only see
// the sink interface. See docs/14-frontend-api-gaps.md G2.
func TestSSESinkFramesEventsForTheClientParser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("POST", "/api/v1/chat/sessions/x/messages/stream", nil)

	sink := &sseSink{c: c}
	if sink.wrote {
		t.Fatalf("headers must be deferred until the first event")
	}

	if err := sink.Citations([]dto.CitationResponse{{ChunkID: "chunk-1", Filename: "manual.md"}}); err != nil {
		t.Fatalf("citations: %v", err)
	}
	if err := sink.Delta("三十天"); err != nil {
		t.Fatalf("delta: %v", err)
	}
	if err := sink.Delta("内可退"); err != nil {
		t.Fatalf("delta: %v", err)
	}
	if err := sink.Done(&dto.SendChatMessageResponse{
		ClientRequestID: "req-1",
		Answer:          "三十天内可退",
	}); err != nil {
		t.Fatalf("done: %v", err)
	}

	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("expected an SSE content type, got %q", got)
	}
	if got := recorder.Header().Get("X-Accel-Buffering"); got != "no" {
		t.Fatalf("a buffering proxy would defeat streaming; expected no, got %q", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("expected no-cache, got %q", got)
	}

	body := recorder.Body.String()
	// Every frame must be event/data separated by a blank line, in order.
	frames := strings.Split(strings.TrimSuffix(body, "\n\n"), "\n\n")
	if len(frames) != 4 {
		t.Fatalf("expected 4 frames, got %d from %q", len(frames), body)
	}
	wantEvents := []string{"citations", "delta", "delta", "done"}
	for i, frame := range frames {
		lines := strings.Split(frame, "\n")
		if len(lines) != 2 {
			t.Fatalf("frame %d must be exactly event+data, got %q", i, frame)
		}
		if lines[0] != "event: "+wantEvents[i] {
			t.Fatalf("frame %d: expected event %s, got %q", i, wantEvents[i], lines[0])
		}
		if !strings.HasPrefix(lines[1], "data: ") {
			t.Fatalf("frame %d: expected a data line, got %q", i, lines[1])
		}
		// A raw newline inside data would silently truncate the frame.
		payload := strings.TrimPrefix(lines[1], "data: ")
		if strings.ContainsAny(payload, "\n\r") {
			t.Fatalf("frame %d: payload must be single-line JSON, got %q", i, payload)
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
			t.Fatalf("frame %d: payload must be JSON, got %q", i, payload)
		}
	}

	if !strings.Contains(body, `"text":"三十天"`) {
		t.Fatalf("expected the delta text to survive framing, got %q", body)
	}
}

// A pre-stream failure must leave the status free for RespondError; only once an
// event has gone out is the response committed to 200.
func TestSSESinkReportsErrorsAsEventsOnceCommitted(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("POST", "/api/v1/chat/sessions/x/messages/stream", nil)

	sink := &sseSink{c: c}
	if err := sink.Delta("部分"); err != nil {
		t.Fatalf("delta: %v", err)
	}
	sink.emitError(apperror.New(500, "CHAT_COMPLETION_FAILED", "回答生成失败，请稍后重试"))

	if recorder.Code != 200 {
		t.Fatalf("a committed stream stays 200, got %d", recorder.Code)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, "event: error") {
		t.Fatalf("expected an error event, got %q", body)
	}
	if !strings.Contains(body, `"code":"CHAT_COMPLETION_FAILED"`) {
		t.Fatalf("the error event must carry the same code a JSON error would, got %q", body)
	}
	if !strings.Contains(body, `"status":500`) {
		t.Fatalf("expected the original status in the payload, got %q", body)
	}
}

// A client that has gone away stops generation instead of letting it run on.
func TestSSESinkStopsOnceTheRequestIsCancelled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	ctx, cancel := context.WithCancel(context.Background())
	c.Request = httptest.NewRequest("POST", "/api/v1/chat/sessions/x/messages/stream", nil).WithContext(ctx)

	sink := &sseSink{c: c}
	if err := sink.Delta("第一段"); err != nil {
		t.Fatalf("first delta: %v", err)
	}

	cancel()
	if err := sink.Delta("第二段"); err == nil {
		t.Fatalf("expected a cancelled request to stop the stream")
	}
	// And it stays stopped, so nothing else is written to a dead connection.
	if err := sink.Done(&dto.SendChatMessageResponse{}); err == nil {
		t.Fatalf("expected the sink to stay failed")
	}
	if strings.Contains(recorder.Body.String(), "event: done") {
		t.Fatalf("done must not reach a disconnected client, got %q", recorder.Body.String())
	}
}
