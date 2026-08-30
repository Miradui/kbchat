package service

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/observability"
)

// The streaming path is where first-token latency is a real measurement, so it
// must be recorded there and the generation total must cover the whole call.
func TestSendMessageStreamRecordsFirstTokenAndGenerationTimings(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	provider := &streamingChatProvider{fakeChatProvider: fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
		"三十天内可退",
	}}}
	service := newStreamingChatService(t, db, provider, chatStreamRetrieval(uuid.New()))
	recorder := observability.NewRecorder()
	service.SetRecorder(recorder)

	if err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: uuid.New().String(),
	}, &recordedStream{}); err != nil {
		t.Fatalf("send message stream: %v", err)
	}

	snapshot := recorder.Snapshot()
	if snapshot.Durations[observability.MetricChatFirstToken].Count != 1 {
		t.Fatalf("expected one first-token sample, got %#v", snapshot.Durations[observability.MetricChatFirstToken])
	}
	if snapshot.Durations[observability.MetricChatGeneration].Count != 1 {
		t.Fatalf("expected one generation sample, got %#v", snapshot.Durations[observability.MetricChatGeneration])
	}
	// Intent classification and the answer are both chat provider calls.
	if snapshot.Providers[observability.ProviderChat].SuccessCount == 0 {
		t.Fatalf("expected chat provider successes, got %#v", snapshot.Providers[observability.ProviderChat])
	}
	if snapshot.Providers[observability.ProviderChat].FailureCount != 0 {
		t.Fatalf("expected no chat provider failures, got %#v", snapshot.Providers[observability.ProviderChat])
	}
}

// A non-streaming provider delivers one synthetic delta only after the whole
// completion is done. Recording that as first-token latency would report
// generation time under a metric operators read as time-to-first-visible-text.
func TestSendMessageDoesNotRecordFirstTokenForNonStreamingProvider(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	provider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
		"三十天内可退",
	}}
	service := newStreamingChatService(t, db, provider, chatStreamRetrieval(uuid.New()))
	recorder := observability.NewRecorder()
	service.SetRecorder(recorder)

	if _, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: uuid.New().String(),
	}); err != nil {
		t.Fatalf("send message: %v", err)
	}

	snapshot := recorder.Snapshot()
	if stats, ok := snapshot.Durations[observability.MetricChatFirstToken]; ok {
		t.Fatalf("non-streaming provider must not record first-token latency, got %#v", stats)
	}
	if snapshot.Durations[observability.MetricChatGeneration].Count != 1 {
		t.Fatalf("expected one generation sample, got %#v", snapshot.Durations[observability.MetricChatGeneration])
	}
}

// The refusal used when retrieval returns nothing is generated locally. It must
// not enter first-token latency, or the metric would look best exactly when
// retrieval is failing.
func TestSendMessageStreamDoesNotRecordFirstTokenForLocalRefusal(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	provider := &streamingChatProvider{fakeChatProvider: fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
	}}}
	service := newStreamingChatService(t, db, provider, &fakeChatRetrieval{
		response: &dto.SearchResponse{Items: []dto.SearchResultResponse{}},
	})
	recorder := observability.NewRecorder()
	service.SetRecorder(recorder)

	sink := &recordedStream{}
	if err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: uuid.New().String(),
	}, sink); err != nil {
		t.Fatalf("send message stream: %v", err)
	}
	if sink.text() == "" {
		t.Fatalf("expected the refusal to be streamed to the client")
	}

	if stats, ok := recorder.Snapshot().Durations[observability.MetricChatFirstToken]; ok {
		t.Fatalf("locally generated refusal must not record first-token latency, got %#v", stats)
	}
}

// A failing provider is exactly when an operator needs the numbers, so the
// generation duration and the failure class must both be recorded.
func TestGenerationTimingIsRecordedWhenTheProviderFails(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	provider := &fakeChatProvider{
		responses: []string{`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`},
		err:       errors.New("provider exploded"),
	}
	service := newStreamingChatService(t, db, provider, chatStreamRetrieval(uuid.New()))
	recorder := observability.NewRecorder()
	service.SetRecorder(recorder)

	if _, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: uuid.New().String(),
	}); err == nil {
		t.Fatalf("expected the send to fail")
	}

	snapshot := recorder.Snapshot()
	if snapshot.Durations[observability.MetricChatGeneration].Count != 1 {
		t.Fatalf("expected a generation sample even on failure, got %#v", snapshot.Durations[observability.MetricChatGeneration])
	}
	chat := snapshot.Providers[observability.ProviderChat]
	if chat.FailureCount == 0 {
		t.Fatalf("expected a recorded chat provider failure, got %#v", chat)
	}
	if chat.LastFailureReason != observability.ReasonUnavailable {
		t.Fatalf("unclassifiable provider error must be unavailable, got %q", chat.LastFailureReason)
	}
}
