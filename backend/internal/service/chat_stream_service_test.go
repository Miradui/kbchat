package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	chatcore "rag/backend/internal/chat"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/model"
	chatprovider "rag/backend/internal/provider/chat"
	"rag/backend/internal/repository"
)

// streamingChatProvider is a fakeChatProvider that also implements
// chatcore.StreamingProvider, splitting each canned answer into runes so the
// tests see more than one delta.
type streamingChatProvider struct {
	fakeChatProvider
	streamCalls int
	// failAfter aborts the stream after this many deltas, simulating a provider
	// or network failure partway through generation.
	failAfter int
}

func (p *streamingChatProvider) ChatStream(ctx context.Context, messages []chatcore.Message, onDelta func(string) error) (string, error) {
	p.streamCalls++
	answer, err := p.fakeChatProvider.Chat(ctx, messages)
	if err != nil {
		return "", err
	}

	var built strings.Builder
	for i, r := range []rune(answer) {
		if p.failAfter > 0 && i >= p.failAfter {
			return "", errors.New("provider stream broke")
		}
		piece := string(r)
		built.WriteString(piece)
		if err := onDelta(piece); err != nil {
			return "", err
		}
	}
	return built.String(), nil
}

type recordedStream struct {
	citations [][]dto.CitationResponse
	deltas    []string
	done      []*dto.SendChatMessageResponse
	// failOnDelta aborts from the sink side, which is what a disconnected
	// client looks like to the service.
	failOnDelta int
}

func (s *recordedStream) Citations(citations []dto.CitationResponse) error {
	s.citations = append(s.citations, citations)
	return nil
}

func (s *recordedStream) Delta(text string) error {
	if s.failOnDelta > 0 && len(s.deltas) >= s.failOnDelta {
		return context.Canceled
	}
	s.deltas = append(s.deltas, text)
	return nil
}

func (s *recordedStream) Done(res *dto.SendChatMessageResponse) error {
	s.done = append(s.done, res)
	return nil
}

func (s *recordedStream) text() string { return strings.Join(s.deltas, "") }

func newStreamingChatService(t *testing.T, db *gorm.DB, provider chatcore.Provider, retrieval chatRetrievalService) *ChatService {
	t.Helper()
	return NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval,
		provider,
		nil,
	)
}

func chatStreamRetrieval(chunkID uuid.UUID) *fakeChatRetrieval {
	return &fakeChatRetrieval{
		response: &dto.SearchResponse{
			Items: []dto.SearchResultResponse{{
				ChunkID:     chunkID.String(),
				DocumentID:  uuid.New().String(),
				Filename:    "manual.md",
				Content:     "退货政策正文",
				VectorScore: 0.9,
			}},
		},
	}
}

func countAssistantMessages(t *testing.T, db *gorm.DB, sessionID uuid.UUID) int64 {
	t.Helper()
	var count int64
	if err := db.Model(&model.ChatMessage{}).
		Where("session_id = ? AND role = ?", sessionID, "assistant").
		Count(&count).Error; err != nil {
		t.Fatalf("count assistant messages: %v", err)
	}
	return count
}

// G2: the happy path — citations land before any text, deltas reassemble into
// the persisted answer, and `done` carries the blocking endpoint's payload.
func TestSendMessageStreamEmitsCitationsThenDeltasThenDone(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	chunkID := uuid.New()
	provider := &streamingChatProvider{fakeChatProvider: fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
		"三十天内可退",
	}}}
	service := newStreamingChatService(t, db, provider, chatStreamRetrieval(chunkID))

	sink := &recordedStream{}
	clientRequestID := uuid.New().String()
	if err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: clientRequestID,
	}, sink); err != nil {
		t.Fatalf("send message stream: %v", err)
	}

	if len(sink.citations) != 1 {
		t.Fatalf("expected exactly one citations event, got %d", len(sink.citations))
	}
	if len(sink.citations[0]) != 1 || sink.citations[0][0].ChunkID != chunkID.String() {
		t.Fatalf("citations must come from this turn's retrieved chunks, got %#v", sink.citations[0])
	}
	if len(sink.deltas) < 2 {
		t.Fatalf("expected the answer to arrive in pieces, got %#v", sink.deltas)
	}
	if sink.text() != "三十天内可退" {
		t.Fatalf("deltas must reassemble into the answer, got %q", sink.text())
	}
	if len(sink.done) != 1 {
		t.Fatalf("expected exactly one done event, got %d", len(sink.done))
	}

	done := sink.done[0]
	if done.Answer != "三十天内可退" {
		t.Fatalf("done must carry the full answer, got %q", done.Answer)
	}
	if done.ClientRequestID != clientRequestID {
		t.Fatalf("done must echo the client request id, got %q", done.ClientRequestID)
	}
	if done.AssistantMessage.ID == "" || done.UserMessage.ID == "" {
		t.Fatalf("done must carry both persisted messages, got %#v", done)
	}
	if len(done.Citations) != 1 || done.Citations[0].ChunkID != chunkID.String() {
		t.Fatalf("done must repeat the citations, got %#v", done.Citations)
	}

	// The persisted answer is the provider's full text, not a concatenation the
	// client could have influenced.
	var stored model.ChatMessage
	if err := db.Where("session_id = ? AND role = ?", session.ID, "assistant").First(&stored).Error; err != nil {
		t.Fatalf("load assistant message: %v", err)
	}
	if stored.Content != "三十天内可退" {
		t.Fatalf("expected the full answer to be persisted, got %q", stored.Content)
	}
}

// G2: replaying a key streams the stored pair back and never reaches a provider,
// so a reconnect cannot mint a second assistant message.
func TestSendMessageStreamReplaysStoredPairWithoutRegenerating(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	chunkID := uuid.New()
	provider := &streamingChatProvider{fakeChatProvider: fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
		"三十天内可退",
	}}}
	service := newStreamingChatService(t, db, provider, chatStreamRetrieval(chunkID))

	clientRequestID := uuid.New().String()
	first := &recordedStream{}
	if err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: clientRequestID,
	}, first); err != nil {
		t.Fatalf("first stream: %v", err)
	}
	callsAfterFirst := len(provider.calls)

	second := &recordedStream{}
	if err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: clientRequestID,
	}, second); err != nil {
		t.Fatalf("replayed stream: %v", err)
	}

	if len(provider.calls) != callsAfterFirst {
		t.Fatalf("a replay must not call the provider again, got %d extra calls", len(provider.calls)-callsAfterFirst)
	}
	if len(second.deltas) != 0 {
		t.Fatalf("a replay has nothing to stream, got %#v", second.deltas)
	}
	if len(second.done) != 1 {
		t.Fatalf("expected the replay to finish with done, got %d", len(second.done))
	}
	if second.done[0].AssistantMessage.ID != first.done[0].AssistantMessage.ID {
		t.Fatalf("expected the original assistant message, got %#v", second.done[0].AssistantMessage)
	}
	if len(second.citations) != 1 || len(second.citations[0]) != 1 {
		t.Fatalf("a replay must still report the stored citations, got %#v", second.citations)
	}
	if got := countAssistantMessages(t, db, session.ID); got != 1 {
		t.Fatalf("expected exactly one assistant message, got %d", got)
	}
}

// G2: the same key with different content is rejected before anything is
// emitted, so the handler can still answer with a status code.
func TestSendMessageStreamRejectsReusedKeyBeforeEmitting(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	clientRequestID := uuid.New()
	if err := repository.NewChatRepository(db).CreateMessages(ctx,
		&model.ChatMessage{SessionID: session.ID, Role: "user", Content: "original", ClientRequestID: &clientRequestID},
		&model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "stored answer", ClientRequestID: &clientRequestID},
	); err != nil {
		t.Fatalf("seed messages: %v", err)
	}

	provider := &streamingChatProvider{fakeChatProvider: fakeChatProvider{err: errors.New("provider should not be called")}}
	service := newStreamingChatService(t, db, provider, &fakeChatRetrieval{})

	sink := &recordedStream{}
	err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "different question",
		ClientRequestID: clientRequestID.String(),
	}, sink)
	assertAppError(t, err, "IDEMPOTENCY_KEY_REUSED")

	if len(sink.citations)+len(sink.deltas)+len(sink.done) != 0 {
		t.Fatalf("a conflict must be detected before any event is emitted, got %#v", sink)
	}
	if len(provider.calls) != 0 {
		t.Fatalf("expected no provider call, got %d", len(provider.calls))
	}
	if got := countAssistantMessages(t, db, session.ID); got != 1 {
		t.Fatalf("expected the stored pair to be untouched, got %d assistant messages", got)
	}
}

// G2: this is the contract the frontend reconciliation depends on. An interrupted
// stream must persist nothing, so looking the key up afterwards finds nothing and
// resending with the same key is safe — and produces exactly one pair.
func TestSendMessageStreamPersistsNothingWhenInterrupted(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	chunkID := uuid.New()
	provider := &streamingChatProvider{fakeChatProvider: fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
		"三十天内可退",
	}}}
	service := newStreamingChatService(t, db, provider, chatStreamRetrieval(chunkID))

	clientRequestID := uuid.New().String()
	// The client goes away after two deltas.
	interrupted := &recordedStream{failOnDelta: 2}
	err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: clientRequestID,
	}, interrupted)
	if err == nil {
		t.Fatalf("expected the interrupted stream to report an error")
	}
	if len(interrupted.done) != 0 {
		t.Fatalf("an interrupted stream must not emit done, got %#v", interrupted.done)
	}

	requestID := uuid.MustParse(clientRequestID)
	stored, err := repository.NewChatRepository(db).FindMessagesByClientRequestID(ctx, session.ID, requestID)
	if err != nil {
		t.Fatalf("look up by client request id: %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("an interrupted stream must persist nothing, found %#v", stored)
	}

	// Which is exactly what makes the resend safe: same key, one clean pair.
	provider.responses = []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
		"三十天内可退",
	}
	resend := &recordedStream{}
	if err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: clientRequestID,
	}, resend); err != nil {
		t.Fatalf("resend after interruption: %v", err)
	}
	if len(resend.done) != 1 || resend.done[0].Answer != "三十天内可退" {
		t.Fatalf("expected the resend to produce a complete answer, got %#v", resend.done)
	}
	if got := countAssistantMessages(t, db, session.ID); got != 1 {
		t.Fatalf("expected exactly one assistant message after resend, got %d", got)
	}
}

// G2: a provider that dies mid-generation is the same story from the other side.
func TestSendMessageStreamPersistsNothingWhenProviderBreaks(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	provider := &streamingChatProvider{
		fakeChatProvider: fakeChatProvider{responses: []string{
			`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
			"三十天内可退",
		}},
		failAfter: 2,
	}
	service := newStreamingChatService(t, db, provider, chatStreamRetrieval(uuid.New()))

	sink := &recordedStream{}
	err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: uuid.New().String(),
	}, sink)
	assertAppError(t, err, "CHAT_COMPLETION_FAILED")

	if got := countAssistantMessages(t, db, session.ID); got != 0 {
		t.Fatalf("a broken generation must persist nothing, got %d assistant messages", got)
	}
	if len(sink.done) != 0 {
		t.Fatalf("expected no done event, got %#v", sink.done)
	}
}

// An OpenAI-compatible server may close cleanly at the HTTP layer after a
// partial delta. Without the protocol-level [DONE] sentinel that is still an
// incomplete generation and must never become a stored assistant message.
func TestSendMessageStreamPersistsNothingWhenOpenAIStreamEndsWithoutDone(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Stream bool `json:"stream"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode provider request: %v", err)
		}
		if !request.Stream {
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"{\"intent\":\"knowledge_base\",\"standaloneQuery\":\"退货\",\"reason\":\"needs docs\"}"}}]}`)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"半截回答\"}}]}\n\n")
	}))
	defer server.Close()

	provider := chatprovider.NewOpenAICompatibleProvider(config.Config{
		ChatBaseURL: server.URL,
		ChatAPIKey:  "test-key",
		ChatModel:   "test-model",
	})
	service := newStreamingChatService(t, db, provider, chatStreamRetrieval(uuid.New()))

	clientRequestID := uuid.New()
	sink := &recordedStream{}
	err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: clientRequestID.String(),
	}, sink)
	assertAppError(t, err, "CHAT_COMPLETION_FAILED")

	if sink.text() != "半截回答" {
		t.Fatalf("expected the partial delta to reach the sink before failure, got %q", sink.text())
	}
	if len(sink.done) != 0 {
		t.Fatalf("an incomplete upstream stream must not emit done, got %#v", sink.done)
	}
	stored, findErr := repository.NewChatRepository(db).FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
	if findErr != nil {
		t.Fatalf("look up messages by client request id: %v", findErr)
	}
	if len(stored) != 0 {
		t.Fatalf("an incomplete upstream stream must persist nothing, found %#v", stored)
	}
}

// A stream that already emitted a different answer cannot finish with the
// winner's pair: that would make the visible deltas contradict done. The
// client must reconcile the now-unknown result by clientRequestId instead.
func TestSendMessageStreamRejectsDivergentConcurrentWinner(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	chunkID := uuid.New()
	clientRequestID := uuid.New()
	provider := &streamingChatProvider{fakeChatProvider: fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
		"三十天内可退",
	}}}
	service := newStreamingChatService(t, db, provider, chatStreamRetrieval(chunkID))

	// Stand in for the racing request: it commits while this one is generating.
	racing := &racingWriterSink{
		db:              db,
		sessionID:       session.ID,
		clientRequestID: clientRequestID,
		content:         "退货政策是什么",
	}
	err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: clientRequestID.String(),
	}, racing)
	if err == nil {
		t.Fatal("a stream whose emitted answer differs from the stored winner must remain unconfirmed")
	}

	if len(racing.done) != 0 {
		t.Fatalf("a divergent stream must not emit done, got %d done events", len(racing.done))
	}
	if got := countAssistantMessages(t, db, session.ID); got != 1 {
		t.Fatalf("expected exactly one assistant message, got %d", got)
	}
}

// racingWriterSink commits a competing pair for the same key just before the
// service under test tries to persist its own.
type racingWriterSink struct {
	recordedStream
	db              *gorm.DB
	sessionID       uuid.UUID
	clientRequestID uuid.UUID
	content         string
	written         bool
}

func (s *racingWriterSink) Delta(text string) error {
	if !s.written {
		s.written = true
		if err := repository.NewChatRepository(s.db).CreateMessages(context.Background(),
			&model.ChatMessage{SessionID: s.sessionID, Role: "user", Content: s.content, ClientRequestID: &s.clientRequestID},
			&model.ChatMessage{SessionID: s.sessionID, Role: "assistant", Content: "抢先写入的回答", ClientRequestID: &s.clientRequestID},
		); err != nil {
			return err
		}
	}
	return s.recordedStream.Delta(text)
}

// G2: a provider without streaming support still serves the endpoint — the whole
// answer arrives as a single delta rather than the request failing.
func TestSendMessageStreamFallsBackToBlockingProvider(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	// Plain fakeChatProvider: implements Provider but not StreamingProvider.
	provider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
		"三十天内可退",
	}}
	service := newStreamingChatService(t, db, provider, chatStreamRetrieval(uuid.New()))

	sink := &recordedStream{}
	if err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: uuid.New().String(),
	}, sink); err != nil {
		t.Fatalf("send with a non-streaming provider: %v", err)
	}

	if len(sink.deltas) != 1 || sink.deltas[0] != "三十天内可退" {
		t.Fatalf("expected one delta carrying the whole answer, got %#v", sink.deltas)
	}
	if len(sink.done) != 1 || sink.done[0].Answer != "三十天内可退" {
		t.Fatalf("expected a normal done event, got %#v", sink.done)
	}
}

// G2: a conversation-intent answer skips retrieval, so it reports no citations
// rather than leaving the client waiting for an event that never comes.
func TestSendMessageStreamAnnouncesEmptyCitationsForConversation(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	retrieval := &fakeChatRetrieval{}
	provider := &streamingChatProvider{fakeChatProvider: fakeChatProvider{responses: []string{
		`{"intent":"conversation","standaloneQuery":"","reason":"chit chat"}`,
		"你好",
	}}}
	service := newStreamingChatService(t, db, provider, retrieval)

	sink := &recordedStream{}
	if err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "你好",
		ClientRequestID: uuid.New().String(),
	}, sink); err != nil {
		t.Fatalf("conversation stream: %v", err)
	}

	if len(sink.citations) != 1 || len(sink.citations[0]) != 0 {
		t.Fatalf("expected one empty citations event, got %#v", sink.citations)
	}
	if len(retrieval.calls) != 0 {
		t.Fatalf("conversation intent must not retrieve, got %#v", retrieval.calls)
	}
	if sink.text() != "你好" {
		t.Fatalf("expected the conversation answer to stream, got %q", sink.text())
	}
}

// G2: with no matching chunks the refusal is streamed too, so the client is not
// left staring at an empty answer until done.
func TestSendMessageStreamStreamsTheNoEvidenceRefusal(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)

	retrieval := &fakeChatRetrieval{response: &dto.SearchResponse{Items: []dto.SearchResultResponse{}}}
	provider := &streamingChatProvider{fakeChatProvider: fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货","reason":"needs docs"}`,
	}}}
	service := newStreamingChatService(t, db, provider, retrieval)

	sink := &recordedStream{}
	if err := service.SendMessageStream(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么",
		ClientRequestID: uuid.New().String(),
	}, sink); err != nil {
		t.Fatalf("no-evidence stream: %v", err)
	}

	if sink.text() == "" {
		t.Fatalf("expected the refusal to be streamed, got no deltas")
	}
	if len(sink.done) != 1 || sink.done[0].Answer != sink.text() {
		t.Fatalf("expected done to match the streamed refusal, got %#v", sink.done)
	}
	if len(sink.done[0].Citations) != 0 {
		t.Fatalf("expected no citations, got %#v", sink.done[0].Citations)
	}
}
