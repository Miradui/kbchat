package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/dto"
	titlecore "kbchat/backend/internal/title"
)

type titleProviderFunc func(context.Context, []titlecore.Message) (string, error)

func (f titleProviderFunc) SummarizeTitle(ctx context.Context, messages []titlecore.Message) (string, error) {
	return f(ctx, messages)
}

func newSessionTitleService(t *testing.T, title string) (*ChatService, uuid.UUID, uuid.UUID) {
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
	return service, user.ID, uuid.MustParse(session.ID)
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

func TestFirstQuestionNamesSessionForBothSendPaths(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, scenario := range []struct {
			name       string
			configured bool
			response   string
			err        error
			want       string
		}{
			{name: "summary", configured: true, response: "《报销发票提交》", want: "报销发票提交"},
			{name: "unconfigured", want: "报销发票 怎么提交？"},
			{name: "provider failure", configured: true, err: errors.New("unavailable"), want: "报销发票 怎么提交？"},
			{name: "empty summary", configured: true, response: "  ", want: "报销发票 怎么提交？"},
		} {
			mode := "json/"
			if stream {
				mode = "stream/"
			}
			t.Run(mode+scenario.name, func(t *testing.T) {
				service, userID, sessionID := newSessionTitleService(t, "")
				titleCalls := 0
				if scenario.configured {
					service.titleProvider = titleProviderFunc(func(_ context.Context, messages []titlecore.Message) (string, error) {
						titleCalls++
						if len(messages) != 2 || !strings.Contains(messages[1].Content, "报销发票\n\t怎么提交？") {
							t.Fatalf("title prompt must contain the first question: %#v", messages)
						}
						if strings.Contains(messages[1].Content, "助手回答") || strings.Contains(messages[1].Content, "与标题无关的助手答复") {
							t.Fatalf("title prompt must not use the assistant answer: %#v", messages)
						}
						return scenario.response, scenario.err
					})
				}
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
				first := dto.SendChatMessageRequest{Content: "  报销发票\n\t怎么提交？  ", ClientRequestID: uuid.NewString()}
				send(first)
				assertSessionTitle(t, service, userID, sessionID, scenario.want)
				send(first) // A replay must not call either provider again.
				send(dto.SendChatMessageRequest{Content: "另一个问题：年假怎么申请？", ClientRequestID: uuid.NewString()})
				assertSessionTitle(t, service, userID, sessionID, scenario.want)
				wantCalls := 0
				if scenario.configured {
					wantCalls = 1
				}
				if titleCalls != wantCalls {
					t.Fatalf("want %d title calls for the first question only, got %d", wantCalls, titleCalls)
				}
				if calls := len(service.chatProvider.(*streamingChatProvider).calls); calls != 4 {
					t.Fatalf("want four chat calls for two turns, got %d", calls)
				}
			})
		}
	}
}

func TestAutoTitlePreservesManualNameDuringSummary(t *testing.T) {
	for _, manualTitle := range []string{"手动保存的会话名称", "报销发票怎么提交？"} {
		t.Run(manualTitle, func(t *testing.T) {
			service, userID, sessionID := newSessionTitleService(t, "")
			service.titleProvider = titleProviderFunc(func(_ context.Context, _ []titlecore.Message) (string, error) {
				assertSessionTitle(t, service, userID, sessionID, "报销发票怎么提交？")
				_, err := service.UpdateSession(context.Background(), userID, sessionID, dto.UpdateChatSessionRequest{Title: manualTitle})
				if err != nil {
					t.Fatalf("manual rename during title generation: %v", err)
				}
				return "模型生成的迟到标题", nil
			})
			_, err := service.SendMessage(context.Background(), userID, sessionID, dto.SendChatMessageRequest{
				Content: "报销发票怎么提交？", ClientRequestID: uuid.NewString(),
			})
			if err != nil {
				t.Fatalf("send: %v", err)
			}
			assertSessionTitle(t, service, userID, sessionID, manualTitle)
		})
	}
}

func TestAutoTitleDoesNotRenameManualTitleOrLaterTurns(t *testing.T) {
	service, userID, sessionID := newSessionTitleService(t, "我的报销记录")
	service.titleProvider = titleProviderFunc(func(context.Context, []titlecore.Message) (string, error) {
		t.Fatal("a named session or later turn must not request a title")
		return "", nil
	})
	first, err := service.SendMessage(context.Background(), userID, sessionID, dto.SendChatMessageRequest{
		Content: "报销发票怎么提交？", ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send first question: %v", err)
	}
	assertSessionTitle(t, service, userID, sessionID, "我的报销记录")
	// Even deliberately naming an existing session 新会话 must remain manual.
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

func TestFirstQuestionTitleSurvivesCanceledSummary(t *testing.T) {
	service, userID, sessionID := newSessionTitleService(t, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service.titleProvider = titleProviderFunc(func(ctx context.Context, _ []titlecore.Message) (string, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("title generation must have a deadline")
		}
		cancel()
		return "", ctx.Err()
	})
	_, err := service.SendMessage(ctx, userID, sessionID, dto.SendChatMessageRequest{
		Content: "报销发票怎么提交？", ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("the answer was already committed: %v", err)
	}
	assertSessionTitle(t, service, userID, sessionID, "报销发票怎么提交？")
}
