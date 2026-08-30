package service

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/model"
)

// emptyCitationJSON is an empty JSON array rather than NULL, matching what the
// success paths write when retrieval found nothing. A NULL would make the column
// mean two things at once: "no citations" and "written before citations existed".
var emptyCitationJSON = datatypes.JSON([]byte(`[]`))

// retrievalFailedAnswer is what the user sees in the conversation. It says the
// system failed rather than that the knowledge base has nothing, because those are
// different problems with different fixes and only the server knows which happened.
const retrievalFailedAnswer = "知识检索暂时不可用，这次没能查到依据。这不代表知识库缺少内容，请稍后重试。"

// isRetrievalInfrastructureFailure reports whether a generation error is the
// system breaking rather than the request being wrong.
//
// Only these get recorded in the conversation. A 404 for a knowledge base the
// caller does not own is a client error and must stay one -- writing "retrieval
// failed" into a session for it would both mislead the user and hand them a hint
// that the id exists. Client disconnects are excluded for the same reason the
// streaming path persists nothing on interruption: there is nobody to show it to,
// and the client resends against the same idempotency key.
func isRetrievalInfrastructureFailure(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var appErr *apperror.Error
	if !errors.As(err, &appErr) {
		// A bare error never reached apperror, so it is not a deliberate client
		// response: treat it as the system failing.
		return true
	}
	switch appErr.Code {
	case "EMBEDDING_FAILED", "RERANK_FAILED", "INTERNAL_ERROR":
		return true
	default:
		// Includes KNOWLEDGE_BASE_NOT_FOUND and CHAT_COMPLETION_FAILED. A provider
		// that fails during generation had usable content in hand, so it is not a
		// retrieval failure; classifying it as one would blame the wrong stage.
		return appErr.Status >= http.StatusInternalServerError && appErr.Code == ""
	}
}

// recordRetrievalFailure persists the question and a labelled failure so the turn
// survives a refresh.
//
// Without this the user loses what they typed: the request 500s, nothing is
// written, and the question is gone from the session. The error is still returned
// to the caller -- persisting the turn is about not destroying the user's input,
// not about pretending the request succeeded.
//
// Written under the same clientRequestID as a successful turn would be, so the
// partial unique index still allows exactly one pair per key. A resend with the
// same id therefore replays this failure instead of silently generating a second
// turn; the client retries with a new id.
func (s *ChatService) recordRetrievalFailure(
	ctx context.Context,
	sessionID, clientRequestID uuid.UUID,
	content string,
	history []model.ChatMessage,
) {
	generated := generatedChatAnswer{
		answer:       retrievalFailedAnswer,
		citationJSON: emptyCitationJSON,
		intent:       chatIntentKnowledgeBase,
		answerStatus: AnswerStatusRetrievalFailed,
	}
	userMessage, assistantMessage, err := buildChatMessagePair(sessionID, clientRequestID, content, generated)
	if err != nil {
		return
	}
	// Best effort: the caller is already returning an error, so a failure to
	// record it must not replace that error with a different one.
	_ = s.chats.CreateMessagesIfUnchanged(ctx, chatMessageIDs(history), userMessage, assistantMessage)
}
