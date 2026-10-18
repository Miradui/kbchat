package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/document/tableconfig"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func uploadReceipt(actorID, kbID uuid.UUID, file documentSource, hash, sourcePath string, options DocumentUploadOptions) (*model.DocumentUploadReceipt, error) {
	if options.RequestID == "" {
		return nil, nil
	}
	id, err := uuid.Parse(options.RequestID)
	if err != nil || id == uuid.Nil {
		return nil, apperror.Validation(map[string]any{"requestId": "上传请求 ID 必须是非空 UUID"})
	}
	// Include the user's decisions, not only the bytes. Future parse settings must
	// be included here too so a receipt can never acknowledge a different import.
	payload, _ := json.Marshal(struct {
		PDFCorrectionHash                 string `json:",omitempty"`
		Filename, ContentHash, SourcePath string
		Size                              int64
		AllowDuplicate                    bool
		Replaces                          *uuid.UUID
		TableImport                       *tableconfig.Options `json:",omitempty"`
	}{correctionFingerprint(options.pdfCorrection), file.Filename, hash, sourcePath, file.Size, options.AllowDuplicate, options.replaces, options.TableImport})
	digest := sha256.Sum256(payload)
	return &model.DocumentUploadReceipt{UserID: actorID, KnowledgeBaseID: kbID, RequestID: id, Fingerprint: hex.EncodeToString(digest[:])}, nil
}
func correctionFingerprint(content []byte) string {
	if len(content) == 0 {
		return ""
	}
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func (s *DocumentService) replayUpload(ctx context.Context, expected *model.DocumentUploadReceipt) (*dto.DocumentResponse, error) {
	if expected == nil {
		return nil, nil
	}
	receipt, err := s.documents.UploadReceipt(ctx, expected.UserID, expected.KnowledgeBaseID, expected.RequestID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if receipt == nil {
		return nil, nil
	}
	if receipt.Fingerprint != expected.Fingerprint {
		return nil, apperror.New(http.StatusConflict, "DOCUMENT_UPLOAD_REQUEST_CONFLICT", "上传请求 ID 已用于不同文件或导入选项")
	}
	result, err := s.uploadReceiptDocument(ctx, receipt)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, apperror.New(http.StatusConflict, "DOCUMENT_UPLOAD_RESULT_UNAVAILABLE", "该请求已成功上传，但文档已删除、移动或不可访问，请刷新文档列表")
	}
	return result, nil
}

func (s *DocumentService) uploadReceiptDocument(ctx context.Context, receipt *model.DocumentUploadReceipt) (*dto.DocumentResponse, error) {
	if receipt.DocumentID == nil {
		return nil, nil
	}
	document, err := s.documents.FindByID(ctx, *receipt.DocumentID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if document == nil || document.KnowledgeBaseID != receipt.KnowledgeBaseID {
		return nil, nil
	}
	return s.Get(ctx, receipt.UserID, document.ID)
}

func (s *DocumentService) UploadResult(ctx context.Context, actorID, kbID, requestID uuid.UUID) (*dto.DocumentUploadResult, error) {
	if _, err := s.authorizeKnowledgeBase(ctx, actorID, kbID, access.CapContentWrite); err != nil {
		return nil, err
	}
	receipt, err := s.documents.UploadReceipt(ctx, actorID, kbID, requestID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if receipt == nil {
		return &dto.DocumentUploadResult{Status: "notFound"}, nil
	}
	document, err := s.uploadReceiptDocument(ctx, receipt)
	if err != nil {
		return nil, err
	}
	if document == nil {
		return &dto.DocumentUploadResult{Status: "unavailable"}, nil
	}
	return &dto.DocumentUploadResult{Status: "committed", Document: document}, nil
}
