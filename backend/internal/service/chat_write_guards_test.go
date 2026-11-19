package service

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"

	chatcore "kbchat/backend/internal/chat"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/rerank"
	"kbchat/backend/internal/retrieval"
)

// The external model boundary lets another request finish while generation is
// in flight, without sleep-based scheduling or replacing a repository method.
type interleavedChatProvider struct {
	fakeChatProvider
	beforeReply func()
}

func (p *interleavedChatProvider) Chat(ctx context.Context, messages []chatcore.Message) (string, error) {
	if before := p.beforeReply; before != nil {
		p.beforeReply = nil
		before()
	}
	return p.fakeChatProvider.Chat(ctx, messages)
}

type unavailableWriteTestEmbedding struct{}

func (unavailableWriteTestEmbedding) EmbedTexts(context.Context, []string) ([][]float32, error) {
	return nil, errors.New("embedding provider unavailable")
}

type chatWriteFixture struct {
	service   *ChatService
	chats     *repository.ChatRepository
	provider  *interleavedChatProvider
	userID    uuid.UUID
	sessionID uuid.UUID
}

func newChatWriteFixture(t *testing.T, responses ...string) chatWriteFixture {
	t.Helper()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	chats := repository.NewChatRepository(db)
	bases := repository.NewKnowledgeBaseRepository(db)
	provider := &interleavedChatProvider{fakeChatProvider: fakeChatProvider{responses: responses}}
	cfg := config.Config{ChatHistoryLimit: 10}
	search := retrieval.NewService(cfg, repository.NewChunkRepository(db), bases, unavailableWriteTestEmbedding{}, rerank.NewDisabledProvider())
	return chatWriteFixture{
		service: NewChatService(cfg, chats, bases, search, provider),
		chats:   chats, provider: provider, userID: user.ID, sessionID: session.ID,
	}
}

func (f chatWriteFixture) send(t *testing.T, question string) *dto.SendChatMessageResponse {
	t.Helper()
	response, err := f.service.SendMessage(context.Background(), f.userID, f.sessionID, dto.SendChatMessageRequest{
		Content: question, ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send question: %v", err)
	}
	return response
}

func TestRegenerateRejectsAnswerFromEarlierQuestion(t *testing.T) {
	const conversation = `{"intent":"conversation"}`
	f := newChatWriteFixture(t, conversation, "first answer", conversation, "second answer", conversation, "stale answer")
	first := f.send(t, "first question")
	f.send(t, "second question")
	before, err := f.chats.ListMessages(context.Background(), f.sessionID)
	if err != nil {
		t.Fatal(err)
	}
	calls := len(f.provider.calls)

	// A stale tab still shows first as the latest answer, although a second
	// question has already committed through the same production service.
	_, err = f.service.RegenerateMessage(context.Background(), f.userID, f.sessionID, uuid.MustParse(first.AssistantMessage.ID))
	assertAdminError(t, err, 409, "CHAT_MESSAGE_CHANGED")
	if len(f.provider.calls) != calls {
		t.Fatal("an answer to an earlier question must be rejected before spending model calls")
	}
	after, err := f.chats.ListMessages(context.Background(), f.sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("stale regeneration changed the saved transcript")
	}
}

func TestRegenerateAllowsOlderVersionOfLatestQuestion(t *testing.T) {
	const conversation = `{"intent":"conversation"}`
	f := newChatWriteFixture(t, conversation, "original answer", conversation, "second version", conversation, "third version")
	first := f.send(t, "question")
	firstID := uuid.MustParse(first.AssistantMessage.ID)
	if _, err := f.service.RegenerateMessage(context.Background(), f.userID, f.sessionID, firstID); err != nil {
		t.Fatalf("create second version: %v", err)
	}
	// The original answer remains a valid target even after another version.
	third, err := f.service.RegenerateMessage(context.Background(), f.userID, f.sessionID, firstID)
	if err != nil {
		t.Fatalf("regenerate original version of final question: %v", err)
	}
	messages, err := f.chats.ListMessages(context.Background(), f.sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 4 || messages[0].ID.String() != first.UserMessage.ID ||
		messages[1].ID != firstID || messages[2].Content != "second version" ||
		messages[3].ID.String() != third.Message.ID {
		t.Fatalf("answer versions no longer belong to the same question: %+v", messages)
	}
}

func TestChatWritesRejectArchiveDuringGeneration(t *testing.T) {
	for _, operation := range []string{"send", "stream", "regenerate", "edit"} {
		t.Run(operation, func(t *testing.T) {
			const conversation = `{"intent":"conversation"}`
			f := newChatWriteFixture(t, conversation, "first answer", conversation, "second answer", conversation, "late answer")
			first := f.send(t, "first question")
			second := f.send(t, "second question")
			ctx := context.Background()
			before, err := f.chats.ListMessages(ctx, f.sessionID)
			if err != nil {
				t.Fatal(err)
			}
			f.provider.beforeReply = func() {
				if _, err := f.service.ArchiveSession(ctx, f.userID, f.sessionID); err != nil {
					t.Fatalf("archive while model request is in flight: %v", err)
				}
			}
			sink := &recordedStream{}
			switch operation {
			case "send":
				_, err = f.service.SendMessage(ctx, f.userID, f.sessionID, dto.SendChatMessageRequest{Content: "late question", ClientRequestID: uuid.NewString()})
			case "stream":
				err = f.service.SendMessageStream(ctx, f.userID, f.sessionID, dto.SendChatMessageRequest{Content: "late question", ClientRequestID: uuid.NewString()}, sink)
			case "regenerate":
				_, err = f.service.RegenerateMessage(ctx, f.userID, f.sessionID, uuid.MustParse(second.AssistantMessage.ID))
			case "edit":
				_, err = f.service.EditMessageAndRegenerate(ctx, f.userID, f.sessionID, uuid.MustParse(first.UserMessage.ID), dto.EditChatMessageRequest{Content: "edited first question", ClientRequestID: uuid.NewString()})
			}
			assertAdminError(t, err, 409, "CHAT_SESSION_ARCHIVED")
			if len(sink.done) != 0 {
				t.Fatal("stream reported success after the session was archived")
			}
			after, err := f.chats.ListMessages(ctx, f.sessionID)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("an in-flight write appended or replaced the archived transcript")
			}
			session, err := f.service.GetSession(ctx, f.userID, f.sessionID)
			if err != nil || session.ArchivedAt == nil {
				t.Fatalf("archived transcript must remain readable and archived: %+v %v", session, err)
			}
		})
	}
}

func TestChatRetrievalFailureDoesNotWriteAfterConcurrentArchive(t *testing.T) {
	for _, operation := range []string{"send", "stream"} {
		t.Run(operation, func(t *testing.T) {
			f := newChatWriteFixture(t, `{"intent":"knowledge_base","standaloneQuery":"question"}`)
			ctx := context.Background()
			f.provider.beforeReply = func() {
				if _, err := f.service.ArchiveSession(ctx, f.userID, f.sessionID); err != nil {
					t.Fatal(err)
				}
			}
			request := dto.SendChatMessageRequest{Content: "question", ClientRequestID: uuid.NewString()}
			var err error
			if operation == "stream" {
				err = f.service.SendMessageStream(ctx, f.userID, f.sessionID, request, &recordedStream{})
			} else {
				_, err = f.service.SendMessage(ctx, f.userID, f.sessionID, request)
			}
			assertAdminError(t, err, 409, "CHAT_SESSION_ARCHIVED")
			messages, err := f.chats.ListMessages(ctx, f.sessionID)
			if err != nil || len(messages) != 0 {
				t.Fatalf("retrieval failure appended messages after archival: %+v %v", messages, err)
			}
		})
	}
}
