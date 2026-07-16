package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"rag/backend/internal/apperror"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
	"rag/backend/internal/storage"
)

const (
	maxPreviewTextBytes        = 1024 * 1024
	documentIDsRequiredMessage = "文档 ID 不能为空"
)

type DocumentService struct {
	cfg            config.Config
	documents      *repository.DocumentRepository
	chunks         *repository.ChunkRepository
	knowledgeBases *repository.KnowledgeBaseRepository
	storage        *storage.LocalStorage
}

func NewDocumentService(
	cfg config.Config,
	documents *repository.DocumentRepository,
	chunks *repository.ChunkRepository,
	knowledgeBases *repository.KnowledgeBaseRepository,
	storage *storage.LocalStorage,
) *DocumentService {
	return &DocumentService{
		cfg:            cfg,
		documents:      documents,
		chunks:         chunks,
		knowledgeBases: knowledgeBases,
		storage:        storage,
	}
}

func (s *DocumentService) Upload(ctx context.Context, ownerID, kbID uuid.UUID, file *multipart.FileHeader) (*dto.DocumentResponse, error) {
	if err := s.ensureKnowledgeBaseOwner(ctx, ownerID, kbID); err != nil {
		return nil, err
	}
	if err := s.validateFile(file); err != nil {
		return nil, err
	}

	storagePath, err := s.storage.SaveKnowledgeBaseFile(kbID, file)
	if err != nil {
		return nil, apperror.Wrap(http.StatusInternalServerError, "DOCUMENT_UPLOAD_FAILED", "document upload failed", err)
	}

	document := &model.Document{
		KnowledgeBaseID: kbID,
		UploaderID:      ownerID,
		Filename:        file.Filename,
		FileType:        strings.TrimPrefix(strings.ToLower(filepath.Ext(file.Filename)), "."),
		FileSize:        file.Size,
		StoragePath:     storagePath,
		Status:          "uploaded",
	}
	job := &model.DocumentJob{
		JobType: "process_document",
		Status:  "pending",
	}
	if err := s.documents.CreateWithJob(ctx, document, job); err != nil {
		_ = s.storage.Delete(storagePath)
		return nil, apperror.Internal(err)
	}
	if err := s.knowledgeBases.TouchUpdatedBy(ctx, kbID, ownerID); err != nil {
		return nil, apperror.Internal(err)
	}

	res := toDocumentResponse(document, job, s.maxDocumentRetries())
	return &res, nil
}

func (s *DocumentService) List(ctx context.Context, ownerID, kbID uuid.UUID) (*dto.DocumentListResponse, error) {
	if err := s.ensureKnowledgeBaseOwner(ctx, ownerID, kbID); err != nil {
		return nil, err
	}

	items, err := s.documents.ListByKnowledgeBase(ctx, kbID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	jobsByDocumentID, err := s.latestJobsForDocuments(ctx, items)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	res := dto.DocumentListResponse{Items: make([]dto.DocumentResponse, 0, len(items))}
	for i := range items {
		res.Items = append(res.Items, toDocumentResponse(&items[i], jobForDocument(jobsByDocumentID, items[i].ID), s.maxDocumentRetries()))
	}
	return &res, nil
}

func (s *DocumentService) ListGlobal(ctx context.Context, ownerID uuid.UUID, query dto.GlobalDocumentListQuery) (*dto.GlobalDocumentListResponse, error) {
	repoQuery, err := toGlobalDocumentRepoQuery(query)
	if err != nil {
		return nil, err
	}
	items, total, err := s.documents.ListByOwner(ctx, ownerID, repoQuery)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	page, pageSize := normalizedPage(query.Page, query.PageSize)
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	jobsByDocumentID, err := s.documents.LatestJobsByDocumentIDs(ctx, ids)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	res := dto.GlobalDocumentListResponse{
		Items:    make([]dto.GlobalDocumentResponse, 0, len(items)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
	for i := range items {
		res.Items = append(res.Items, toGlobalDocumentResponse(&items[i], jobForDocument(jobsByDocumentID, items[i].ID), s.maxDocumentRetries()))
	}
	return &res, nil
}

func (s *DocumentService) Get(ctx context.Context, ownerID, documentID uuid.UUID) (*dto.DocumentResponse, error) {
	document, err := s.findDocument(ctx, ownerID, documentID)
	if err != nil {
		return nil, err
	}
	job, err := s.latestJobForDocument(ctx, document.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := toDocumentResponse(document, job, s.maxDocumentRetries())
	return &res, nil
}

func (s *DocumentService) Delete(ctx context.Context, ownerID, documentID uuid.UUID) error {
	document, err := s.findDocument(ctx, ownerID, documentID)
	if err != nil {
		return err
	}
	if err := s.documents.Delete(ctx, document); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

func (s *DocumentService) BatchDelete(ctx context.Context, ownerID uuid.UUID, req dto.DocumentBatchRequest) (*dto.DocumentBatchResultResponse, error) {
	ids := normalizeUUIDs(req.DocumentIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"documentIds": documentIDsRequiredMessage})
	}
	if err := s.ensureDocumentsOwner(ctx, ownerID, ids, false); err != nil {
		return nil, err
	}
	for _, id := range ids {
		document, err := s.documents.FindByIDAndOwner(ctx, id, ownerID)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		if document == nil {
			return nil, apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
		}
		if err := s.documents.Delete(ctx, document); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	return &dto.DocumentBatchResultResponse{ProcessedCount: len(ids)}, nil
}

func (s *DocumentService) ListRecycleBin(ctx context.Context, ownerID uuid.UUID, page, pageSize int) (*dto.RecycleBinListResponse, error) {
	items, total, err := s.documents.ListDeletedByOwner(ctx, ownerID, page, pageSize)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	page, pageSize = normalizedPage(page, pageSize)
	res := &dto.RecycleBinListResponse{
		Items:    make([]dto.RecycleBinItemResponse, 0, len(items)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
	for i := range items {
		res.Items = append(res.Items, dto.RecycleBinItemResponse{
			ResourceType:      "document",
			ID:                items[i].ID.String(),
			Name:              items[i].Filename,
			KnowledgeBaseID:   items[i].KnowledgeBaseID.String(),
			KnowledgeBaseName: items[i].KnowledgeBaseName,
			DeletedAt:         items[i].DeletedAt,
		})
	}
	return res, nil
}

func (s *DocumentService) Restore(ctx context.Context, ownerID, documentID uuid.UUID) error {
	document, err := s.documents.FindDeletedByIDAndOwner(ctx, documentID, ownerID)
	if err != nil {
		return apperror.Internal(err)
	}
	if document == nil {
		return apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
	}
	if err := s.documents.Restore(ctx, documentID); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

func (s *DocumentService) BatchRestore(ctx context.Context, ownerID uuid.UUID, req dto.DocumentBatchRequest) (*dto.DocumentBatchResultResponse, error) {
	ids := normalizeUUIDs(req.DocumentIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"documentIds": documentIDsRequiredMessage})
	}
	if err := s.ensureDocumentsOwner(ctx, ownerID, ids, true); err != nil {
		return nil, err
	}
	for _, id := range ids {
		if err := s.documents.Restore(ctx, id); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	return &dto.DocumentBatchResultResponse{ProcessedCount: len(ids)}, nil
}

func (s *DocumentService) Reprocess(ctx context.Context, ownerID, documentID uuid.UUID) (*dto.DocumentResponse, error) {
	document, err := s.findDocument(ctx, ownerID, documentID)
	if err != nil {
		return nil, err
	}
	if err := s.chunks.DeleteByDocument(ctx, document.ID); err != nil {
		return nil, apperror.Internal(err)
	}
	if err := s.documents.UpdateStatus(ctx, document.ID, "uploaded", ""); err != nil {
		return nil, apperror.Internal(err)
	}
	document.Status = "uploaded"
	document.ErrorMessage = ""

	job := &model.DocumentJob{
		DocumentID: document.ID,
		JobType:    "process_document",
		Status:     "pending",
	}
	if err := s.documents.CreateJob(ctx, job); err != nil {
		return nil, apperror.Internal(err)
	}
	if err := s.knowledgeBases.TouchUpdatedBy(ctx, document.KnowledgeBaseID, ownerID); err != nil {
		return nil, apperror.Internal(err)
	}

	res := toDocumentResponse(document, job, s.maxDocumentRetries())
	return &res, nil
}

func (s *DocumentService) BatchReprocess(ctx context.Context, ownerID uuid.UUID, req dto.DocumentBatchRequest) (*dto.DocumentBatchResultResponse, error) {
	ids := normalizeUUIDs(req.DocumentIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"documentIds": documentIDsRequiredMessage})
	}
	if err := s.ensureDocumentsOwner(ctx, ownerID, ids, false); err != nil {
		return nil, err
	}
	for _, id := range ids {
		document, err := s.documents.FindByIDAndOwner(ctx, id, ownerID)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		if document == nil {
			return nil, apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
		}
		if err := s.chunks.DeleteByDocument(ctx, document.ID); err != nil {
			return nil, apperror.Internal(err)
		}
		if err := s.documents.UpdateStatus(ctx, document.ID, "uploaded", ""); err != nil {
			return nil, apperror.Internal(err)
		}
		job := &model.DocumentJob{
			DocumentID: document.ID,
			JobType:    "process_document",
			Status:     "pending",
		}
		if err := s.documents.CreateJob(ctx, job); err != nil {
			return nil, apperror.Internal(err)
		}
		if err := s.knowledgeBases.TouchUpdatedBy(ctx, document.KnowledgeBaseID, ownerID); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	return &dto.DocumentBatchResultResponse{ProcessedCount: len(ids)}, nil
}

func (s *DocumentService) Download(ctx context.Context, ownerID, documentID uuid.UUID) (*dto.DocumentDownloadResponse, error) {
	document, err := s.findDocument(ctx, ownerID, documentID)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(document.StoragePath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, apperror.NotFound("DOCUMENT_FILE_NOT_FOUND", "document file not found")
		}
		return nil, apperror.Internal(err)
	}
	contentType := contentTypeForFile(document.Filename)
	return &dto.DocumentDownloadResponse{
		Filename:    document.Filename,
		FileType:    document.FileType,
		ContentType: contentType,
		Path:        document.StoragePath,
	}, nil
}

func (s *DocumentService) Preview(ctx context.Context, ownerID, documentID uuid.UUID) (*dto.DocumentPreviewResponse, error) {
	document, err := s.findDocument(ctx, ownerID, documentID)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(document.StoragePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, apperror.NotFound("DOCUMENT_FILE_NOT_FOUND", "document file not found")
		}
		return nil, apperror.Internal(err)
	}
	contentType := contentTypeForFile(document.Filename)
	res := &dto.DocumentPreviewResponse{
		ID:          document.ID.String(),
		Filename:    document.Filename,
		FileType:    document.FileType,
		ContentType: contentType,
		Kind:        previewKind(document.Filename),
		DownloadURL: fmt.Sprintf("/api/v1/documents/%s/download", document.ID.String()),
	}
	if res.Kind != "text" {
		return res, nil
	}
	if info.Size() > maxPreviewTextBytes {
		return nil, apperror.New(http.StatusBadRequest, "FILE_TOO_LARGE_FOR_PREVIEW", "document is too large to preview")
	}
	content, err := os.ReadFile(document.StoragePath)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res.Content = string(content)
	return res, nil
}

func (s *DocumentService) Chunks(ctx context.Context, ownerID, documentID uuid.UUID, query dto.ChunkListQuery) (*dto.ChunkListResponse, error) {
	if _, err := s.findDocument(ctx, ownerID, documentID); err != nil {
		return nil, err
	}

	page, pageSize := normalizedPage(query.Page, query.PageSize)
	chunks, total, err := s.chunks.ListByDocumentPaged(ctx, documentID, query.Q, page, pageSize)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	res := dto.ChunkListResponse{
		Items:    make([]dto.ChunkResponse, 0, len(chunks)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
	for i := range chunks {
		res.Items = append(res.Items, toChunkResponse(&chunks[i]))
	}
	return &res, nil
}

func (s *DocumentService) PermanentDelete(ctx context.Context, ownerID, documentID uuid.UUID) error {
	document, err := s.documents.FindDeletedByIDAndOwner(ctx, documentID, ownerID)
	if err != nil {
		return apperror.Internal(err)
	}
	if document == nil {
		return apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
	}
	if err := s.documents.PermanentDelete(ctx, documentID); err != nil {
		return apperror.Internal(err)
	}
	_ = s.storage.Delete(document.StoragePath)
	return nil
}

func (s *DocumentService) EmptyRecycleBin(ctx context.Context, ownerID uuid.UUID) error {
	if err := s.documents.EmptyDeletedByOwner(ctx, ownerID); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

func (s *DocumentService) ensureKnowledgeBaseOwner(ctx context.Context, ownerID, kbID uuid.UUID) error {
	kb, err := s.knowledgeBases.FindByIDAndOwner(ctx, kbID, ownerID)
	if err != nil {
		return apperror.Internal(err)
	}
	if kb == nil {
		return apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "knowledge base not found")
	}
	return nil
}

func toChunkResponse(chunk *model.DocumentChunk) dto.ChunkResponse {
	metadata := map[string]any{}
	if len(chunk.Metadata) > 0 {
		_ = json.Unmarshal(chunk.Metadata, &metadata)
	}

	return dto.ChunkResponse{
		ID:         chunk.ID.String(),
		ChunkIndex: chunk.ChunkIndex,
		Content:    chunk.Content,
		TokenCount: chunk.TokenCount,
		PageNumber: chunk.PageNumber,
		Metadata:   metadata,
	}
}

func (s *DocumentService) findDocument(ctx context.Context, ownerID, documentID uuid.UUID) (*model.Document, error) {
	document, err := s.documents.FindByIDAndOwner(ctx, documentID, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if document == nil {
		return nil, apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
	}
	return document, nil
}

func (s *DocumentService) ensureDocumentsOwner(ctx context.Context, ownerID uuid.UUID, ids []uuid.UUID, deleted bool) error {
	for _, id := range ids {
		var (
			document *model.Document
			err      error
		)
		if deleted {
			document, err = s.documents.FindDeletedByIDAndOwner(ctx, id, ownerID)
		} else {
			document, err = s.documents.FindByIDAndOwner(ctx, id, ownerID)
		}
		if err != nil {
			return apperror.Internal(err)
		}
		if document == nil {
			return apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
		}
	}
	return nil
}

func (s *DocumentService) validateFile(file *multipart.FileHeader) error {
	if file == nil {
		return apperror.Validation(map[string]any{"file": "file is required"})
	}
	if file.Size <= 0 {
		return apperror.Validation(map[string]any{"file": "file is required"})
	}
	if file.Size > int64(s.cfg.MaxUploadSizeMB)*1024*1024 {
		return apperror.Validation(map[string]any{"file": "file size exceeds limit"})
	}

	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(file.Filename)), ".")
	switch ext {
	case "txt", "md", "pdf":
		return nil
	default:
		return apperror.New(http.StatusBadRequest, "DOCUMENT_TYPE_UNSUPPORTED", "unsupported document type")
	}
}

func (s *DocumentService) latestJobsForDocuments(ctx context.Context, documents []model.Document) (map[uuid.UUID]model.DocumentJob, error) {
	ids := make([]uuid.UUID, 0, len(documents))
	for _, document := range documents {
		ids = append(ids, document.ID)
	}
	return s.documents.LatestJobsByDocumentIDs(ctx, ids)
}

func (s *DocumentService) latestJobForDocument(ctx context.Context, documentID uuid.UUID) (*model.DocumentJob, error) {
	jobsByDocumentID, err := s.documents.LatestJobsByDocumentIDs(ctx, []uuid.UUID{documentID})
	if err != nil {
		return nil, err
	}
	return jobForDocument(jobsByDocumentID, documentID), nil
}

func jobForDocument(jobsByDocumentID map[uuid.UUID]model.DocumentJob, documentID uuid.UUID) *model.DocumentJob {
	job, ok := jobsByDocumentID[documentID]
	if !ok {
		return nil
	}
	return &job
}

func (s *DocumentService) maxDocumentRetries() int {
	if s.cfg.WorkerMaxRetries > 0 {
		return s.cfg.WorkerMaxRetries
	}
	return 3
}

type documentProgressInfo struct {
	JobStatus   string
	Progress    int
	Stage       string
	RetryCount  int
	MaxRetries  int
	NextRetryAt *time.Time
}

func toDocumentResponse(document *model.Document, job *model.DocumentJob, maxRetries int) dto.DocumentResponse {
	var errorMessage *string
	if document.ErrorMessage != "" {
		errorMessage = &document.ErrorMessage
	}
	progress := documentProgress(document.Status, job, maxRetries)

	return dto.DocumentResponse{
		ID:              document.ID.String(),
		KnowledgeBaseID: document.KnowledgeBaseID.String(),
		Filename:        document.Filename,
		FileType:        document.FileType,
		FileSize:        document.FileSize,
		Status:          document.Status,
		ErrorMessage:    errorMessage,
		JobStatus:       progress.JobStatus,
		Progress:        progress.Progress,
		Stage:           progress.Stage,
		RetryCount:      progress.RetryCount,
		MaxRetries:      progress.MaxRetries,
		NextRetryAt:     progress.NextRetryAt,
		CreatedAt:       document.CreatedAt,
		UpdatedAt:       document.UpdatedAt,
	}
}

func toGlobalDocumentRepoQuery(query dto.GlobalDocumentListQuery) (repository.GlobalDocumentQuery, error) {
	page, pageSize := normalizedPage(query.Page, query.PageSize)
	res := repository.GlobalDocumentQuery{
		Q:        strings.TrimSpace(query.Q),
		Status:   query.Status,
		FileType: query.FileType,
		Sort:     query.Sort,
		Page:     page,
		PageSize: pageSize,
	}
	if query.KnowledgeBaseID != nil && *query.KnowledgeBaseID != "" {
		id, err := uuid.Parse(*query.KnowledgeBaseID)
		if err != nil {
			return res, apperror.Validation(map[string]any{"knowledgeBaseId": "知识库 ID 不合法"})
		}
		res.KnowledgeBaseID = id
	}
	return res, nil
}

func toGlobalDocumentResponse(document *repository.GlobalDocumentListItem, job *model.DocumentJob, maxRetries int) dto.GlobalDocumentResponse {
	var errorMessage *string
	if document.ErrorMessage != "" {
		errorMessage = &document.ErrorMessage
	}
	progress := documentProgress(document.Status, job, maxRetries)
	return dto.GlobalDocumentResponse{
		ID:                document.ID.String(),
		KnowledgeBaseID:   document.KnowledgeBaseID.String(),
		KnowledgeBaseName: document.KnowledgeBaseName,
		Filename:          document.Filename,
		FileType:          document.FileType,
		FileSize:          document.FileSize,
		Status:            document.Status,
		ErrorMessage:      errorMessage,
		JobStatus:         progress.JobStatus,
		Progress:          progress.Progress,
		Stage:             progress.Stage,
		RetryCount:        progress.RetryCount,
		MaxRetries:        progress.MaxRetries,
		NextRetryAt:       progress.NextRetryAt,
		CreatedAt:         document.CreatedAt,
		UpdatedAt:         document.UpdatedAt,
	}
}

func documentProgress(status string, job *model.DocumentJob, maxRetries int) documentProgressInfo {
	stage := normalizedDocumentStage(status)
	info := documentProgressInfo{
		JobStatus:  inferredJobStatus(stage),
		Progress:   progressForStage(stage),
		Stage:      stage,
		MaxRetries: maxRetries,
	}
	if job == nil {
		return info
	}
	if strings.TrimSpace(job.Status) != "" {
		info.JobStatus = job.Status
	}
	info.RetryCount = job.RetryCount
	if job.Status == "pending" && job.LockedAt != nil {
		info.NextRetryAt = job.LockedAt
	}
	return info
}

func normalizedDocumentStage(status string) string {
	switch status {
	case "parsing", "chunking", "embedding", "completed", "failed":
		return status
	default:
		return "uploaded"
	}
}

func inferredJobStatus(stage string) string {
	switch stage {
	case "completed", "failed":
		return stage
	case "uploaded":
		return "pending"
	default:
		return "running"
	}
}

func progressForStage(stage string) int {
	switch stage {
	case "parsing":
		return 25
	case "chunking":
		return 50
	case "embedding":
		return 75
	case "completed", "failed":
		return 100
	default:
		return 0
	}
}

func normalizedPage(page, pageSize int) (int, int) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}

func contentTypeForFile(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".txt":
		return "text/plain; charset=utf-8"
	case ".md":
		return "text/markdown; charset=utf-8"
	case ".pdf":
		return "application/pdf"
	default:
		return "application/octet-stream"
	}
}

func previewKind(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".txt", ".md":
		return "text"
	default:
		return "file"
	}
}
