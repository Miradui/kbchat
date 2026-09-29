package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/storage"
)

const (
	maxPreviewTextBytes            = 1024 * 1024
	documentIDsRequiredMessage     = "文档 ID 不能为空"
	uploadStorageReservationDelay  = 10 * time.Minute
	defaultStorageOperationTimeout = 2 * time.Minute
)

type DocumentService struct {
	cfg            config.Config
	documents      *repository.DocumentRepository
	chunks         *repository.ChunkRepository
	knowledgeBases *repository.KnowledgeBaseRepository
	storageCleanup *repository.StorageCleanupRepository
	storage        storage.Storage
	activities     *ActivityRecorder
}

// SetActivityRecorder wires the workspace timeline. Optional; see the
// KnowledgeBaseService counterpart.
func (s *DocumentService) SetActivityRecorder(recorder *ActivityRecorder) {
	s.activities = recorder
}

func NewDocumentService(
	cfg config.Config,
	documents *repository.DocumentRepository,
	chunks *repository.ChunkRepository,
	knowledgeBases *repository.KnowledgeBaseRepository,
	storageCleanup *repository.StorageCleanupRepository,
	storage storage.Storage,
) *DocumentService {
	return &DocumentService{
		cfg:            cfg,
		documents:      documents,
		chunks:         chunks,
		knowledgeBases: knowledgeBases,
		storageCleanup: storageCleanup,
		storage:        storage,
	}
}

// DocumentUploadOptions carries the caller's decision about an already-known
// file. It is a struct so a later option does not change every call site.
type DocumentUploadOptions struct {
	// AllowDuplicate records that the user saw the conflict and chose to keep
	// both copies. Without it a matching content hash is rejected.
	AllowDuplicate bool
}

func (s *DocumentService) Upload(ctx context.Context, ownerID, kbID uuid.UUID, file *multipart.FileHeader) (*dto.DocumentResponse, error) {
	return s.UploadWithOptions(ctx, ownerID, kbID, file, DocumentUploadOptions{})
}

func (s *DocumentService) UploadWithOptions(
	ctx context.Context,
	ownerID, kbID uuid.UUID,
	file *multipart.FileHeader,
	options DocumentUploadOptions,
) (*dto.DocumentResponse, error) {
	if _, err := s.authorizeKnowledgeBase(ctx, ownerID, kbID, access.CapContentWrite); err != nil {
		return nil, err
	}
	if err := s.validateFile(file); err != nil {
		return nil, err
	}
	return s.uploadSource(ctx, ownerID, kbID, documentSource{Filename: file.Filename, Size: file.Size, Open: func() (io.ReadCloser, error) { return file.Open() }}, options)
}

func (s *DocumentService) uploadSource(ctx context.Context, ownerID, kbID uuid.UUID, file documentSource, options DocumentUploadOptions) (*dto.DocumentResponse, error) {

	// Hashed and checked before anything is written: a duplicate is then rejected
	// without an object to clean up, and without a storage reservation to cancel.
	contentHash, err := hashDocumentSource(file)
	if err != nil {
		return nil, apperror.Wrap(http.StatusInternalServerError, "DOCUMENT_UPLOAD_FAILED", "document upload failed", err)
	}
	if !options.AllowDuplicate {
		existing, err := s.documents.FindByContentHash(ctx, kbID, contentHash)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		if existing != nil {
			return nil, newDuplicateDocumentError(existing)
		}
	}

	storagePath := s.storage.NewKnowledgeBaseFileLocation(kbID, file.Filename)
	if err := s.storageCleanup.Reserve(ctx, storagePath, time.Now().Add(uploadStorageReservationDelay)); err != nil {
		return nil, apperror.Wrap(http.StatusInternalServerError, "DOCUMENT_UPLOAD_FAILED", "document upload failed", err)
	}
	if err := s.saveDocumentSource(ctx, storagePath, file); err != nil {
		if cleanupErr := s.cleanupUploadedFile(ctx, storagePath); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("delete uploaded file: %w", cleanupErr))
		} else {
			s.cancelStorageReservation(ctx, storagePath)
		}
		return nil, apperror.Wrap(http.StatusInternalServerError, "DOCUMENT_UPLOAD_FAILED", "document upload failed", err)
	}

	document := &model.Document{
		KnowledgeBaseID: kbID,
		UploaderID:      ownerID,
		Filename:        file.Filename,
		FileType:        fileTypeOf(file.Filename),
		FileSize:        file.Size,
		StoragePath:     storagePath,
		Status:          "uploaded",
		ContentHash:     &contentHash,
	}
	job := &model.DocumentJob{
		JobType: "process_document",
		Status:  "pending",
	}
	if err := s.documents.CreateWithJobAndReleaseStorageReservation(ctx, document, job, ownerID); err != nil {
		if cleanupErr := s.cleanupUploadedFile(ctx, storagePath); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("delete uploaded file: %w", cleanupErr))
		} else {
			s.cancelStorageReservation(ctx, storagePath)
		}
		return nil, apperror.Internal(err)
	}

	s.recordDocumentActivity(ctx, ownerID, ActivityDocumentUploaded, document)
	res := toDocumentResponse(document, job, s.maxDocumentRetries(), s.staleAfterDays())
	return &res, nil
}

func (s *DocumentService) cleanupUploadedFile(ctx context.Context, storagePath string) error {
	timeout := s.cfg.StorageOperationTimeout
	if timeout <= 0 {
		timeout = defaultStorageOperationTimeout
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	defer cancel()
	return s.storage.Delete(cleanupCtx, storagePath)
}

func (s *DocumentService) cancelStorageReservation(ctx context.Context, storagePath string) {
	timeout := s.cfg.StorageOperationTimeout
	if timeout <= 0 {
		timeout = defaultStorageOperationTimeout
	}
	cancelCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	defer cancel()
	_ = s.storageCleanup.CancelReservation(cancelCtx, storagePath)
}

// List is the knowledge-base-scoped view of the same ledger ListGlobal serves.
// It pins knowledgeBaseId to the path parameter and otherwise accepts and
// returns exactly what the global endpoint does, so the two cannot drift.
// See docs/04-api-design.md (GET /knowledge-bases/:kbId/documents).
func (s *DocumentService) List(ctx context.Context, ownerID, kbID uuid.UUID, query dto.GlobalDocumentListQuery) (*dto.GlobalDocumentListResponse, error) {
	// Checked up front so a knowledge base the caller cannot reach answers
	// KNOWLEDGE_BASE_NOT_FOUND instead of an empty page.
	if _, err := s.authorizeKnowledgeBase(ctx, ownerID, kbID, access.CapDocumentRead); err != nil {
		return nil, err
	}

	scopedID := kbID.String()
	query.KnowledgeBaseID = &scopedID
	return s.ListGlobal(ctx, ownerID, query)
}

func (s *DocumentService) ListGlobal(ctx context.Context, ownerID uuid.UUID, query dto.GlobalDocumentListQuery) (*dto.GlobalDocumentListResponse, error) {
	repoQuery, err := toGlobalDocumentRepoQuery(query)
	if err != nil {
		return nil, err
	}
	items, total, err := s.documents.ListForActor(ctx, ownerID, access.MemberRolesWith(access.CapDocumentRead), repoQuery)
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
		res.Items = append(res.Items, toGlobalDocumentResponse(
			&items[i],
			jobForDocument(jobsByDocumentID, items[i].ID),
			s.maxDocumentRetries(),
			s.staleAfterDays(),
		))
	}
	return &res, nil
}

func (s *DocumentService) Get(ctx context.Context, ownerID, documentID uuid.UUID) (*dto.DocumentResponse, error) {
	document, err := s.authorizeDocument(ctx, ownerID, documentID, access.CapDocumentRead)
	if err != nil {
		return nil, err
	}
	job, err := s.latestJobForDocument(ctx, document.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := toDocumentResponse(document, job, s.maxDocumentRetries(), s.staleAfterDays())
	return &res, nil
}

func (s *DocumentService) Delete(ctx context.Context, ownerID, documentID uuid.UUID) error {
	document, err := s.authorizeDocument(ctx, ownerID, documentID, access.CapContentWrite)
	if err != nil {
		return err
	}
	if err := s.documents.Delete(ctx, document); err != nil {
		return apperror.Internal(err)
	}
	s.recordDocumentActivity(ctx, ownerID, ActivityDocumentDeleted, document)
	return nil
}

func (s *DocumentService) BatchDelete(ctx context.Context, ownerID uuid.UUID, req dto.DocumentBatchRequest) (*dto.DocumentBatchResultResponse, error) {
	ids := normalizeUUIDs(req.DocumentIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"documentIds": documentIDsRequiredMessage})
	}
	if err := s.ensureDocumentsCapability(ctx, ownerID, ids, access.CapContentWrite, false); err != nil {
		return nil, err
	}
	if err := s.documents.BatchDelete(ctx, ids); err != nil {
		return nil, apperror.Internal(err)
	}
	return &dto.DocumentBatchResultResponse{ProcessedCount: len(ids)}, nil
}

func (s *DocumentService) ListRecycleBin(ctx context.Context, ownerID uuid.UUID, page, pageSize int) (*dto.RecycleBinListResponse, error) {
	// Scoped to content.write, not document.read: the bin only offers restore and
	// purge, so listing it for a viewer would show items they cannot act on.
	items, total, err := s.documents.ListDeletedForActor(ctx, ownerID, access.MemberRolesWith(access.CapContentWrite), page, pageSize)
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
	document, err := s.authorizeDeletedDocument(ctx, ownerID, documentID, access.CapContentWrite)
	if err != nil {
		return err
	}
	if err := s.documents.Restore(ctx, documentID); err != nil {
		if errors.Is(err, repository.ErrDocumentNotDeleted) {
			return apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
		}
		return apperror.Internal(err)
	}
	s.recordDocumentActivity(ctx, ownerID, ActivityDocumentRestored, document)
	return nil
}

func (s *DocumentService) BatchRestore(ctx context.Context, ownerID uuid.UUID, req dto.DocumentBatchRequest) (*dto.DocumentBatchResultResponse, error) {
	ids := normalizeUUIDs(req.DocumentIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"documentIds": documentIDsRequiredMessage})
	}
	if err := s.ensureDocumentsCapability(ctx, ownerID, ids, access.CapContentWrite, true); err != nil {
		return nil, err
	}
	if err := s.documents.BatchRestore(ctx, ids); err != nil {
		if errors.Is(err, repository.ErrDocumentNotDeleted) {
			return nil, apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
		}
		return nil, apperror.Internal(err)
	}
	return &dto.DocumentBatchResultResponse{ProcessedCount: len(ids)}, nil
}

func (s *DocumentService) Reprocess(ctx context.Context, ownerID, documentID uuid.UUID) (*dto.DocumentResponse, error) {
	document, err := s.authorizeDocument(ctx, ownerID, documentID, access.CapContentWrite)
	if err != nil {
		return nil, err
	}
	job, created, err := s.documents.QueueReprocess(ctx, document.ID, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if created {
		document.Status = "uploaded"
		document.ErrorMessage = ""
	}
	res := toDocumentResponse(document, job, s.maxDocumentRetries(), s.staleAfterDays())
	return &res, nil
}

func (s *DocumentService) BatchReprocess(ctx context.Context, ownerID uuid.UUID, req dto.DocumentBatchRequest) (*dto.DocumentBatchResultResponse, error) {
	ids := normalizeUUIDs(req.DocumentIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"documentIds": documentIDsRequiredMessage})
	}
	if err := s.ensureDocumentsCapability(ctx, ownerID, ids, access.CapContentWrite, false); err != nil {
		return nil, err
	}
	if err := s.documents.QueueBatchReprocess(ctx, ids, ownerID); err != nil {
		return nil, apperror.Internal(err)
	}
	return &dto.DocumentBatchResultResponse{ProcessedCount: len(ids)}, nil
}

func (s *DocumentService) Download(ctx context.Context, ownerID, documentID uuid.UUID) (*dto.DocumentDownloadResponse, error) {
	document, err := s.authorizeDocument(ctx, ownerID, documentID, access.CapDocumentDownload)
	if err != nil {
		return nil, err
	}
	reader, info, err := s.storage.Open(ctx, document.StoragePath)
	if err != nil {
		return nil, documentStorageError(err)
	}
	contentType := contentTypeForFile(document.Filename)
	return &dto.DocumentDownloadResponse{
		Filename:    document.Filename,
		FileType:    document.FileType,
		ContentType: contentType,
		Size:        info.Size,
		Reader:      reader,
	}, nil
}

func (s *DocumentService) Preview(ctx context.Context, ownerID, documentID uuid.UUID) (*dto.DocumentPreviewResponse, error) {
	document, err := s.authorizeDocument(ctx, ownerID, documentID, access.CapDocumentRead)
	if err != nil {
		return nil, err
	}
	info, err := s.storage.Stat(ctx, document.StoragePath)
	if err != nil {
		return nil, documentStorageError(err)
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
	if info.Size > maxPreviewTextBytes {
		return nil, apperror.New(http.StatusBadRequest, "FILE_TOO_LARGE_FOR_PREVIEW", "document is too large to preview")
	}
	content, err := s.storage.Read(ctx, document.StoragePath)
	if err != nil {
		return nil, documentStorageError(err)
	}
	if strings.EqualFold(document.FileType, "docx") {
		parsed, parseErr := parser.NewDefaultParser().ParseBytes(content, "docx")
		if parseErr != nil {
			return nil, apperror.New(http.StatusBadRequest, "DOCUMENT_PREVIEW_FAILED", "文档无法解析")
		}
		parts := make([]string, 0, len(parsed.Segments))
		for _, segment := range parsed.Segments {
			parts = append(parts, segment.Content)
		}
		res.Content = strings.Join(parts, "\n")
	} else {
		res.Content = string(content)
	}
	return res, nil
}

func (s *DocumentService) Chunks(ctx context.Context, ownerID, documentID uuid.UUID, query dto.ChunkListQuery) (*dto.ChunkListResponse, error) {
	if _, err := s.authorizeDocument(ctx, ownerID, documentID, access.CapDocumentRead); err != nil {
		return nil, err
	}

	page, pageSize := normalizedPage(query.Page, query.PageSize)
	chunks, total, err := s.chunks.ListByDocumentPaged(ctx, documentID, query.ChunkID, query.Q, page, pageSize)
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
	if _, err := s.authorizeDeletedDocument(ctx, ownerID, documentID, access.CapContentPurge); err != nil {
		return err
	}
	if err := s.documents.PermanentDelete(ctx, documentID); err != nil {
		if errors.Is(err, repository.ErrDocumentNotDeleted) {
			return apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
		}
		return apperror.Internal(err)
	}
	return nil
}

func documentStorageError(err error) error {
	if errors.Is(err, storage.ErrNotFound) {
		return apperror.NotFound("DOCUMENT_FILE_NOT_FOUND", "document file not found")
	}
	return apperror.Internal(err)
}

func (s *DocumentService) EmptyRecycleBin(ctx context.Context, ownerID uuid.UUID) error {
	if err := s.documents.EmptyDeletedForActor(ctx, ownerID, access.MemberRolesWith(access.CapContentPurge)); err != nil {
		return apperror.Internal(err)
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

// MaxDocumentFilenameLength matches the documents.filename column. Published by
// GET /system/capabilities so the rename form validates against this same value.
const MaxDocumentFilenameLength = 255

// Update renames a document and optionally moves it to another knowledge base.
//
// The extension has to stay the same: fileType is derived from it at upload and
// drives parser selection, so letting a rename change ".pdf" to ".txt" would
// point the parser at a file it cannot read on the next reprocess.
func (s *DocumentService) Update(ctx context.Context, ownerID, documentID uuid.UUID, req dto.DocumentUpdateRequest) (*dto.DocumentResponse, error) {
	document, err := s.authorizeDocument(ctx, ownerID, documentID, access.CapContentWrite)
	if err != nil {
		return nil, err
	}

	filename := strings.TrimSpace(req.Filename)
	if filename != "" {
		if utf8.RuneCountInString(filename) > MaxDocumentFilenameLength {
			return nil, apperror.Validation(map[string]any{"filename": "文件名过长"})
		}
		if strings.ContainsAny(filename, "/\\") {
			return nil, apperror.Validation(map[string]any{"filename": "文件名不能包含路径分隔符"})
		}
		if !strings.EqualFold(filepath.Ext(filename), filepath.Ext(document.Filename)) {
			return nil, apperror.New(http.StatusBadRequest, "DOCUMENT_EXTENSION_IMMUTABLE", "重命名不能修改文件扩展名")
		}
	}

	var target *uuid.UUID
	if req.KnowledgeBaseID != nil && *req.KnowledgeBaseID != document.KnowledgeBaseID {
		// The destination is checked separately: moving a document into a knowledge
		// base is writing content there, and the source role says nothing about it.
		if _, err := s.authorizeKnowledgeBase(ctx, ownerID, *req.KnowledgeBaseID, access.CapContentWrite); err != nil {
			return nil, err
		}
		target = req.KnowledgeBaseID
	}
	if filename == "" && target == nil {
		// Nothing to change; return the current state rather than touching rows.
		job, err := s.latestJobForDocument(ctx, document.ID)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		res := toDocumentResponse(document, job, s.maxDocumentRetries(), s.staleAfterDays())
		return &res, nil
	}

	if err := s.documents.UpdateMetadata(ctx, document.ID, filename, target, ownerID); err != nil {
		if errors.Is(err, repository.ErrDocumentJobActive) {
			return nil, apperror.New(http.StatusConflict, "DOCUMENT_JOB_ACTIVE", "文档正在处理中，处理完成后才能移动")
		}
		return nil, apperror.Internal(err)
	}

	updated, err := s.authorizeDocument(ctx, ownerID, document.ID, access.CapDocumentRead)
	if err != nil {
		return nil, err
	}
	job, err := s.latestJobForDocument(ctx, updated.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if target != nil {
		// Only a move is worth a timeline entry; a rename is visible in place.
		s.recordDocumentActivity(ctx, ownerID, ActivityDocumentMoved, updated)
	}
	res := toDocumentResponse(updated, job, s.maxDocumentRetries(), s.staleAfterDays())
	return &res, nil
}

// CancelJob stops a queued or running document job. Already embedded batches are
// not rolled back, and the processor only swaps chunks in after every batch
// succeeded, so a cancel never leaves half an index behind.
func (s *DocumentService) CancelJob(ctx context.Context, ownerID, documentID uuid.UUID) (*dto.DocumentResponse, error) {
	document, err := s.authorizeDocument(ctx, ownerID, documentID, access.CapContentWrite)
	if err != nil {
		return nil, err
	}

	job, err := s.documents.CancelActiveJob(ctx, document.ID, ownerID)
	if err != nil {
		if errors.Is(err, repository.ErrDocumentJobNotCancellable) {
			return nil, apperror.New(http.StatusConflict, "DOCUMENT_JOB_NOT_CANCELLABLE", "文档当前没有可取消的处理任务")
		}
		return nil, apperror.Internal(err)
	}

	updated, err := s.authorizeDocument(ctx, ownerID, document.ID, access.CapDocumentRead)
	if err != nil {
		return nil, err
	}
	s.recordDocumentActivity(ctx, ownerID, ActivityDocumentCancelled, updated)
	res := toDocumentResponse(updated, job, s.maxDocumentRetries(), s.staleAfterDays())
	return &res, nil
}

// recordDocumentActivity resolves the knowledge base name so the entry stays
// readable after the document or the knowledge base is gone.
func (s *DocumentService) recordDocumentActivity(ctx context.Context, userID uuid.UUID, action string, document *model.Document) {
	if s.activities == nil {
		return
	}
	knowledgeBaseName := ""
	if kb, err := s.knowledgeBases.FindByID(ctx, document.KnowledgeBaseID); err == nil && kb != nil {
		knowledgeBaseName = kb.Name
	}
	knowledgeBaseID := document.KnowledgeBaseID
	s.activities.Record(ctx, userID, ActivityEntry{
		Action:            action,
		ResourceType:      "document",
		ResourceID:        document.ID,
		ResourceName:      document.Filename,
		KnowledgeBaseID:   &knowledgeBaseID,
		KnowledgeBaseName: knowledgeBaseName,
	})
}

// AllowedDocumentExtensions is the upload allow list enforced by validateFile.
// GET /api/v1/system/capabilities publishes it so the import dialog offers the
// same set instead of a frontend copy.
var AllowedDocumentExtensions = []string{"txt", "md", "pdf", "docx"}

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
	if ext == "doc" {
		err := apperror.New(http.StatusBadRequest, "DOCUMENT_TYPE_UNSUPPORTED", "legacy .doc is not supported; save the file as .docx")
		err.Details["reason"] = "legacy_doc"
		return err
	}
	for _, allowed := range AllowedDocumentExtensions {
		if ext == allowed {
			switch ext {
			case "pdf":
				return validatePDFSignature(file)
			case "docx":
				return validateDOCXSignature(file)
			}
			return nil
		}
	}
	return apperror.New(http.StatusBadRequest, "DOCUMENT_TYPE_UNSUPPORTED", "unsupported document type")
}

func validatePDFSignature(file *multipart.FileHeader) error {
	opened, err := file.Open()
	if err != nil {
		return apperror.New(http.StatusBadRequest, "DOCUMENT_TYPE_UNSUPPORTED", "unsupported document type")
	}
	defer opened.Close()

	header := make([]byte, 1024)
	n, readErr := io.ReadFull(opened, header)
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		return apperror.New(http.StatusBadRequest, "DOCUMENT_TYPE_UNSUPPORTED", "unsupported document type")
	}
	if !bytes.Contains(header[:n], []byte("%PDF-")) {
		return apperror.New(http.StatusBadRequest, "DOCUMENT_TYPE_UNSUPPORTED", "unsupported document type")
	}
	return nil
}

func validateDOCXSignature(file *multipart.FileHeader) error {
	opened, err := file.Open()
	if err != nil {
		return apperror.New(http.StatusBadRequest, "DOCUMENT_TYPE_UNSUPPORTED", "unsupported document type")
	}
	defer opened.Close()

	header := make([]byte, 8)
	n, readErr := io.ReadFull(opened, header)
	if readErr != nil && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		return apperror.New(http.StatusBadRequest, "DOCUMENT_TYPE_UNSUPPORTED", "unsupported document type")
	}
	if isOLEMagic(header[:n]) {
		// A .docx extension over a compound file is either a renamed legacy .doc
		// or an Office-encrypted package. Say which so the user knows to convert
		// or decrypt instead of re-uploading the same file.
		err := apperror.New(http.StatusBadRequest, "DOCUMENT_TYPE_UNSUPPORTED", "legacy .doc or encrypted Word document is not supported; save as an unencrypted .docx")
		err.Details["reason"] = "legacy_or_encrypted"
		return err
	}
	if !isZIPMagic(header[:n]) {
		return apperror.New(http.StatusBadRequest, "DOCUMENT_TYPE_UNSUPPORTED", "unsupported document type")
	}
	return nil
}

func isOLEMagic(header []byte) bool {
	return bytes.HasPrefix(header, []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1})
}

func isZIPMagic(header []byte) bool {
	if len(header) < 4 || header[0] != 'P' || header[1] != 'K' {
		return false
	}
	// Local file header, empty archive, and spanning archive signatures are all
	// valid ZIP signatures. The parser still requires word/document.xml, so an
	// arbitrary empty ZIP cannot become a document by passing this check.
	return (header[2] == 3 && header[3] == 4) ||
		(header[2] == 5 && header[3] == 6) ||
		(header[2] == 7 && header[3] == 8)
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

// toDocumentResponse takes staleAfterDays rather than reading the config so the
// mapper stays a pure function; the service passes its configured value in.
func toDocumentResponse(document *model.Document, job *model.DocumentJob, maxRetries int, staleAfterDays int) dto.DocumentResponse {
	var errorMessage *string
	if document.ErrorMessage != "" {
		message := publicDocumentErrorMessage(document.ErrorMessage)
		errorMessage = &message
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
		ErrorCode:       stringValue(document.ErrorCode),
		SupersededByID:  supersededByID(document.SupersededByID),
		SupersededAt:    document.SupersededAt,
		IsStale:         isStaleDocument(document, staleAfterDays, time.Now()),
		StaleAfterDays:  staleAfterDays,
	}
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func supersededByID(id *uuid.UUID) *string {
	if id == nil {
		return nil
	}
	value := id.String()
	return &value
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

func toGlobalDocumentResponse(
	document *repository.GlobalDocumentListItem,
	job *model.DocumentJob,
	maxRetries int,
	staleAfterDays int,
) dto.GlobalDocumentResponse {
	var errorMessage *string
	if document.ErrorMessage != "" {
		message := publicDocumentErrorMessage(document.ErrorMessage)
		errorMessage = &message
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
		ErrorCode:         stringValue(document.ErrorCode),
		SupersededByID:    supersededByID(document.SupersededByID),
		SupersededAt:      document.SupersededAt,
		IsStale: isStaleDocument(&model.Document{
			Status:         document.Status,
			SupersededByID: document.SupersededByID,
			UpdatedAt:      document.UpdatedAt,
		}, staleAfterDays, time.Now()),
		StaleAfterDays: staleAfterDays,
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
	if job.Status == "completed" {
		info.Progress = 100
	} else if job.Progress > 0 {
		info.Progress = job.Progress
	}
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
	case "completed":
		return 100
	case "failed":
		return 0
	default:
		return 0
	}
}

func publicDocumentErrorMessage(raw string) string {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	if normalized == repository.DocumentJobCancelledMessage {
		return "文档处理已取消。"
	}
	if strings.Contains(normalized, "api_key is required") ||
		strings.Contains(normalized, "api key is required") ||
		strings.Contains(normalized, "base_url is required") ||
		strings.Contains(normalized, "base url is required") ||
		strings.Contains(normalized, "model is required") {
		return "文档处理服务尚未配置完成，请联系管理员完成配置后再重处理。"
	}
	return "文档处理失败，请检查文件内容或稍后重处理。"
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
	case ".docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	default:
		return "application/octet-stream"
	}
}

func previewKind(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".txt", ".md", ".docx":
		return "text"
	default:
		return "file"
	}
}
