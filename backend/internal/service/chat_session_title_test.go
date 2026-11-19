package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/apperror"
	chatcore "kbchat/backend/internal/chat"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func newSessionTitleService(t *testing.T, title string) (*ChatService, uuid.UUID, uuid.UUID, *gorm.DB) {
	t.Helper()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	provider := &streamingChatProvider{}
	for range 4 {
		provider.responses = append(provider.responses,
			`{"intent":"conversation","standaloneQuery":"","reason":"conversation"}`,
			"与标题无关的助手答复",
		)
	}
	service := newStreamingChatService(t, db, provider, &fakeChatRetrieval{})
	session, err := service.CreateSession(context.Background(), user.ID, dto.CreateChatSessionRequest{
		KnowledgeBaseID: kb.ID.String(), Title: title,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	return service, user.ID, uuid.MustParse(session.ID), db
}

func assertSessionTitle(t *testing.T, service *ChatService, userID, sessionID uuid.UUID, want string) {
	t.Helper()
	session, err := service.GetSession(context.Background(), userID, sessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if session.Title != want {
		t.Fatalf("want title %q, got %q", want, session.Title)
	}
}

type sessionTitleProviderWithRename struct {
	*streamingChatProvider
	beforeAnswer func(context.Context) error
}

func (p *sessionTitleProviderWithRename) renameBeforeAnswer(ctx context.Context) error {
	if len(p.calls) == 1 && p.beforeAnswer != nil {
		return p.beforeAnswer(ctx)
	}
	return nil
}

func (p *sessionTitleProviderWithRename) Chat(ctx context.Context, messages []chatcore.Message) (string, error) {
	if err := p.renameBeforeAnswer(ctx); err != nil {
		return "", err
	}
	return p.streamingChatProvider.Chat(ctx, messages)
}

func (p *sessionTitleProviderWithRename) ChatStream(ctx context.Context, messages []chatcore.Message, onDelta func(string) error) (string, error) {
	if err := p.renameBeforeAnswer(ctx); err != nil {
		return "", err
	}
	return p.streamingChatProvider.ChatStream(ctx, messages, onDelta)
}

func TestFirstQuestionTitlePreservesManualRenameDuringGeneration(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, manualTitle := range []string{"手动保存的会话名称", "新会话"} {
			mode := "json/"
			if stream {
				mode = "stream/"
			}
			t.Run(mode+manualTitle, func(t *testing.T) {
				service, userID, sessionID, _ := newSessionTitleService(t, "")
				renamed := false
				service.chatProvider = &sessionTitleProviderWithRename{
					streamingChatProvider: service.chatProvider.(*streamingChatProvider),
					beforeAnswer: func(ctx context.Context) error {
						_, err := service.UpdateSession(ctx, userID, sessionID, dto.UpdateChatSessionRequest{Title: manualTitle})
						renamed = err == nil
						return err
					},
				}
				req := dto.SendChatMessageRequest{Content: "报销发票怎么提交？", ClientRequestID: uuid.NewString()}
				var err error
				if stream {
					err = service.SendMessageStream(context.Background(), userID, sessionID, req, &recordedStream{})
				} else {
					_, err = service.SendMessage(context.Background(), userID, sessionID, req)
				}
				if err != nil || !renamed {
					t.Fatalf("rename during generation was not accepted: renamed=%v, send error=%v", renamed, err)
				}
				assertSessionTitle(t, service, userID, sessionID, manualTitle)
			})
		}
	}
}

func TestFirstQuestionTitleRollsBackWithMessagePersistence(t *testing.T) {
	for _, operation := range []string{"assistant insert", "session update"} {
		t.Run(operation, func(t *testing.T) {
			service, userID, sessionID, db := newSessionTitleService(t, "")
			const callback = "title:persistence-failure"
			injected := false
			fail := func(tx *gorm.DB) {
				injected = true
				tx.AddError(errors.New("injected persistence failure"))
			}
			if operation == "assistant insert" {
				if err := db.Callback().Create().Before("gorm:create").Register(callback, func(tx *gorm.DB) {
					message, ok := tx.Statement.Dest.(*model.ChatMessage)
					if ok && message.Role == "assistant" {
						fail(tx)
					}
				}); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { db.Callback().Create().Remove(callback) })
			} else {
				if err := db.Callback().Update().Before("gorm:update").Register(callback, func(tx *gorm.DB) {
					updates, ok := tx.Statement.Dest.(map[string]any)
					if ok && tx.Statement.Table == "chat_sessions" && updates["title"] != nil {
						fail(tx)
					}
				}); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { db.Callback().Update().Remove(callback) })
			}
			if _, err := service.SendMessage(context.Background(), userID, sessionID, dto.SendChatMessageRequest{
				Content: "报销发票怎么提交？", ClientRequestID: uuid.NewString(),
			}); err == nil || !injected {
				t.Fatalf("expected the injected persistence failure: injected=%v, error=%v", injected, err)
			}
			assertSessionTitle(t, service, userID, sessionID, "新会话")
			var count int64
			if err := db.Model(&model.ChatMessage{}).Where("session_id = ?", sessionID).Count(&count).Error; err != nil || count != 0 {
				t.Fatalf("failed first turn was partially persisted: count=%d, error=%v", count, err)
			}
		})
	}
}

func TestFirstQuestionTitleNamesRetrievalFailureAndPreservesReplay(t *testing.T) {
	for _, stream := range []bool{false, true} {
		mode := "json"
		if stream {
			mode = "stream"
		}
		t.Run(mode, func(t *testing.T) {
			service, userID, sessionID, db := newSessionTitleService(t, "")
			provider := service.chatProvider.(*streamingChatProvider)
			provider.responses = []string{`{"intent":"knowledge_base","standaloneQuery":"报销发票","reason":"needs docs"}`}
			service.retrieval.(*fakeChatRetrieval).err = apperror.Wrap(500, "EMBEDDING_FAILED", "embedding failed", errors.New("fixture unavailable"))
			req := dto.SendChatMessageRequest{Content: "报销发票怎么提交？", ClientRequestID: uuid.NewString()}
			send := func() error {
				if stream {
					return service.SendMessageStream(context.Background(), userID, sessionID, req, &recordedStream{})
				}
				_, err := service.SendMessage(context.Background(), userID, sessionID, req)
				return err
			}
			if err := send(); err == nil {
				t.Fatal("expected the retrieval failure to be returned")
			}
			assertSessionTitle(t, service, userID, sessionID, req.Content)
			if err := send(); err != nil {
				t.Fatalf("replay stored failure: %v", err)
			}
			assertSessionTitle(t, service, userID, sessionID, req.Content)
			var messages []model.ChatMessage
			if err := db.Where("session_id = ?", sessionID).Order("created_at, id").Find(&messages).Error; err != nil || len(messages) != 2 {
				t.Fatalf("failure replay must keep one message pair: %#v, %v", messages, err)
			}
			if len(provider.calls) != 1 || messages[1].AnswerStatus == nil || *messages[1].AnswerStatus != AnswerStatusRetrievalFailed {
				t.Fatalf("failure replay called a provider or lost its status: calls=%d, status=%v", len(provider.calls), messages[1].AnswerStatus)
			}
		})
	}
}

func TestFirstQuestionTitleStaysDefaultWhenStreamIsCancelled(t *testing.T) {
	service, userID, sessionID, db := newSessionTitleService(t, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := service.SendMessageStream(ctx, userID, sessionID, dto.SendChatMessageRequest{
		Content: "报销发票怎么提交？", ClientRequestID: uuid.NewString(),
	}, &recordedStream{cancelAfterDeltas: 1, cancel: cancel})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	assertSessionTitle(t, service, userID, sessionID, "新会话")
	var count int64
	if err := db.Model(&model.ChatMessage{}).Where("session_id = ?", sessionID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("cancelled first turn was persisted: count=%d, error=%v", count, err)
	}
}

func TestFirstQuestionNamesSessionForBothSendPaths(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, scenario := range []struct{ name, question, want string }{
			{"whitespace", "  报销发票\n\t怎么提交？  ", "报销发票 怎么提交？"},
			{"unicode truncation", strings.Repeat("🙂", 35), strings.Repeat("🙂", 29) + "…"},
		} {
			mode := "json/"
			if stream {
				mode = "stream/"
			}
			t.Run(mode+scenario.name, func(t *testing.T) {
				service, userID, sessionID, _ := newSessionTitleService(t, "")
				send := func(req dto.SendChatMessageRequest) {
					t.Helper()
					var err error
					if stream {
						err = service.SendMessageStream(context.Background(), userID, sessionID, req, &recordedStream{})
					} else {
						_, err = service.SendMessage(context.Background(), userID, sessionID, req)
					}
					if err != nil {
						t.Fatalf("send: %v", err)
					}
				}
				first := dto.SendChatMessageRequest{Content: scenario.question, ClientRequestID: uuid.NewString()}
				send(first)
				assertSessionTitle(t, service, userID, sessionID, scenario.want)
				send(first)
				send(dto.SendChatMessageRequest{Content: "年假怎么申请？", ClientRequestID: uuid.NewString()})
				assertSessionTitle(t, service, userID, sessionID, scenario.want)
				if calls := len(service.chatProvider.(*streamingChatProvider).calls); calls != 4 {
					t.Fatalf("want only intent and answer calls for two turns, got %d", calls)
				}
			})
		}
	}
}

func TestFirstQuestionTitlePreservesConcurrentManualRename(t *testing.T) {
	for _, manualTitle := range []string{"手动保存的会话名称", "新会话"} {
		t.Run(manualTitle, func(t *testing.T) {
			service, userID, sessionID, db := newSessionTitleService(t, "")
			renamed := false
			manualAt := time.Now().UTC().Truncate(time.Microsecond)
			const callback = "title:concurrent-manual-rename"
			if err := db.Callback().Update().Before("gorm:update").Register(callback, func(tx *gorm.DB) {
				updates, ok := tx.Statement.Dest.(map[string]any)
				if renamed || !ok || tx.Statement.Table != "chat_sessions" || updates["title"] == nil {
					return
				}
				renamed = true
				err := tx.Session(&gorm.Session{NewDB: true, SkipDefaultTransaction: true}).
					Model(&model.ChatSession{}).Where("id = ? AND user_id = ?", sessionID, userID).
					Updates(map[string]any{"title": manualTitle, "updated_at": manualAt}).Error
				if err != nil {
					tx.AddError(err)
				}
			}); err != nil {
				t.Fatal(err)
			}
			defer db.Callback().Update().Remove(callback)
			_, err := service.SendMessage(context.Background(), userID, sessionID, dto.SendChatMessageRequest{
				Content: "报销发票怎么提交？", ClientRequestID: uuid.NewString(),
			})
			if err != nil {
				t.Fatalf("send: %v", err)
			}
			if !renamed {
				t.Fatal("manual rename race was not exercised")
			}
			assertSessionTitle(t, service, userID, sessionID, manualTitle)
			current, err := service.GetSession(context.Background(), userID, sessionID)
			if err != nil || current.UpdatedAt.Before(manualAt) {
				t.Fatalf("session timestamp moved behind the accepted manual rename: %#v, %v", current, err)
			}
		})
	}
}

func TestFirstQuestionTitleDoesNotRenameManualTitleOrLaterTurns(t *testing.T) {
	service, userID, sessionID, _ := newSessionTitleService(t, "我的报销记录")
	first, err := service.SendMessage(context.Background(), userID, sessionID, dto.SendChatMessageRequest{
		Content: "报销发票怎么提交？", ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send first question: %v", err)
	}
	assertSessionTitle(t, service, userID, sessionID, "我的报销记录")
	if _, err := service.UpdateSession(context.Background(), userID, sessionID, dto.UpdateChatSessionRequest{Title: "新会话"}); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if _, err := service.SendMessage(context.Background(), userID, sessionID, dto.SendChatMessageRequest{
		Content: "年假怎么申请？", ClientRequestID: uuid.NewString(),
	}); err != nil {
		t.Fatalf("send second question: %v", err)
	}
	edited, err := service.EditMessageAndRegenerate(context.Background(), userID, sessionID, uuid.MustParse(first.UserMessage.ID), dto.EditChatMessageRequest{
		Content: "修改后的首问", ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("edit first question: %v", err)
	}
	if _, err := service.RegenerateMessage(context.Background(), userID, sessionID, uuid.MustParse(edited.AssistantMessage.ID)); err != nil {
		t.Fatalf("regenerate: %v", err)
	}
	assertSessionTitle(t, service, userID, sessionID, "新会话")
}
