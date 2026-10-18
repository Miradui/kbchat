package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
)

type DocumentVersionStatus struct {
	DocumentID   string                    `json:"documentId"`
	State        string                    `json:"state"`
	Current      *dto.ChatDocumentResponse `json:"current"`
	NewerPending bool                      `json:"newerPending"`
}

func (s *DocumentService) VersionStatus(ctx context.Context, actor uuid.UUID, values []string) ([]DocumentVersionStatus, error) {
	ids, err := dto.ParseDocumentIDs(values)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"documentIds": "请选择文档"})
	}
	for _, id := range ids {
		if _, err := s.authorizeDocument(ctx, actor, id, access.CapDocumentRead); err != nil {
			return nil, err
		}
	}
	rows, err := s.documents.VersionStates(ctx, ids)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	statuses := map[uuid.UUID]*DocumentVersionStatus{}
	latestLive, publishedDepth := map[uuid.UUID]int{}, map[uuid.UUID]int{}
	for _, id := range ids {
		statuses[id] = &DocumentVersionStatus{DocumentID: id.String(), State: "unavailable"}
		publishedDepth[id] = -1
	}
	for _, row := range rows {
		if row.Depth >= 100 {
			return nil, apperror.New(400, "DOCUMENT_VERSION_LIMIT", "版本链异常或超过 100 个，请先检查版本关系")
		}
		if !row.Live {
			continue
		}
		latestLive[row.SourceID] = row.Depth
		if row.Published {
			item := statuses[row.SourceID]
			item.Current = &dto.ChatDocumentResponse{ID: row.ID.String(), KnowledgeBaseID: row.KnowledgeBaseID.String(), Filename: row.Filename}
			item.State = "current"
			if row.ID != row.SourceID {
				item.State = "newer_available"
			}
			publishedDepth[row.SourceID] = row.Depth
		}
	}
	result := make([]DocumentVersionStatus, 0, len(ids))
	for _, id := range ids {
		if _, err := s.authorizeDocument(ctx, actor, id, access.CapDocumentRead); err != nil {
			return nil, err
		}
		item := statuses[id]
		item.NewerPending = latestLive[id] > publishedDepth[id] && latestLive[id] > 0
		if item.Current != nil {
			if _, err := s.authorizeDocument(ctx, actor, uuid.MustParse(item.Current.ID), access.CapDocumentRead); err != nil {
				return nil, err
			}
		}
		result = append(result, *item)
	}
	return result, nil
}
