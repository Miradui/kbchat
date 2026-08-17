package service

import (
	"context"

	"github.com/google/uuid"

	"rag/backend/internal/dto"
)

// HomeSummaryItemLimit is how many rows each home list carries. The server owns
// this number so the workspace no longer has to guess a pageSize per section.
// See docs/14-frontend-api-gaps.md G17.
const HomeSummaryItemLimit = 5

// HomeService composes the existing services rather than querying directly, so
// the ownership and soft-delete rules stay defined in exactly one place per
// resource. It only aggregates; it adds no new access path.
type HomeService struct {
	knowledgeBases *KnowledgeBaseService
	documents      *DocumentService
	chats          *ChatService
}

func NewHomeService(
	knowledgeBases *KnowledgeBaseService,
	documents *DocumentService,
	chats *ChatService,
) *HomeService {
	return &HomeService{knowledgeBases: knowledgeBases, documents: documents, chats: chats}
}

func (s *HomeService) Summary(ctx context.Context, userID uuid.UUID, period string) (*dto.HomeSummaryResponse, error) {
	period = normalizePeriod(period)

	stats, err := s.knowledgeBases.Stats(ctx, userID, period)
	if err != nil {
		return nil, err
	}

	knowledgeBases, err := s.knowledgeBases.ListWorkspace(ctx, userID, dto.KnowledgeBaseListQuery{
		Sort:     "updatedAt_desc",
		Page:     1,
		PageSize: HomeSummaryItemLimit,
	})
	if err != nil {
		return nil, err
	}

	documents, err := s.documents.ListGlobal(ctx, userID, dto.GlobalDocumentListQuery{
		Sort:     "updatedAt_desc",
		Page:     1,
		PageSize: HomeSummaryItemLimit,
	})
	if err != nil {
		return nil, err
	}

	failedDocuments, err := s.documents.ListGlobal(ctx, userID, dto.GlobalDocumentListQuery{
		Status:   "failed",
		Sort:     "updatedAt_desc",
		Page:     1,
		PageSize: HomeSummaryItemLimit,
	})
	if err != nil {
		return nil, err
	}

	sessions, err := s.chats.ListSessions(ctx, userID, dto.ChatSessionListQuery{
		Page:     1,
		PageSize: HomeSummaryItemLimit,
	})
	if err != nil {
		return nil, err
	}

	return &dto.HomeSummaryResponse{
		Period:              period,
		Stats:               *stats,
		KnowledgeBases:      knowledgeBases.Items,
		KnowledgeBaseTotal:  knowledgeBases.Total,
		Documents:           documents.Items,
		DocumentTotal:       documents.Total,
		FailedDocuments:     failedDocuments.Items,
		FailedDocumentTotal: failedDocuments.Total,
		Sessions:            sessions.Items,
		SessionTotal:        sessions.Total,
	}, nil
}
