package service

import (
	"context"
	"errors"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

// Replace uploads a new revision of an existing document and marks the old one
// as superseded.
//
// The old document is kept, not overwritten. Overwriting in place would mean
// deleting the object and the chunks of a document that is currently answering
// questions, and if the new file then failed to parse the knowledge base would
// have lost content it used to have. Instead the replacement goes through the
// normal upload and processing path, and the old revision is only pointed at the
// new one -- retrieval keeps working throughout, and the version trail survives.
//
// Duplicate detection is deliberately skipped: re-uploading a file that is byte
// identical to something else in the knowledge base is exactly what a caller who
// asked for a replacement means to do.
func (s *DocumentService) Replace(
	ctx context.Context,
	ownerID, documentID uuid.UUID,
	file *multipart.FileHeader,
) (*dto.DocumentResponse, error) {
	old, err := s.authorizeDocument(ctx, ownerID, documentID, access.CapContentWrite)
	if err != nil {
		return nil, err
	}
	if old.SupersededByID != nil {
		return nil, apperror.New(
			http.StatusConflict,
			"DOCUMENT_ALREADY_SUPERSEDED",
			"该文档已被替换，请替换最新版本",
		)
	}
	if err := s.validateFile(file); err != nil {
		return nil, err
	}

	contentHash, err := hashUploadedFile(file)
	if err != nil {
		return nil, apperror.Wrap(http.StatusInternalServerError, "DOCUMENT_UPLOAD_FAILED", "document upload failed", err)
	}

	storagePath := s.storage.NewKnowledgeBaseFileLocation(old.KnowledgeBaseID, file.Filename)
	if err := s.storageCleanup.Reserve(ctx, storagePath, time.Now().Add(uploadStorageReservationDelay)); err != nil {
		return nil, apperror.Wrap(http.StatusInternalServerError, "DOCUMENT_UPLOAD_FAILED", "document upload failed", err)
	}
	if err := s.storage.SaveKnowledgeBaseFile(ctx, storagePath, file); err != nil {
		s.discardUpload(ctx, storagePath)
		return nil, apperror.Wrap(http.StatusInternalServerError, "DOCUMENT_UPLOAD_FAILED", "document upload failed", err)
	}

	document := &model.Document{
		KnowledgeBaseID: old.KnowledgeBaseID,
		UploaderID:      ownerID,
		Filename:        file.Filename,
		FileType:        fileTypeOf(file.Filename),
		FileSize:        file.Size,
		StoragePath:     storagePath,
		Status:          "uploaded",
		ContentHash:     &contentHash,
	}
	job := &model.DocumentJob{JobType: "process_document", Status: "pending"}
	if err := s.documents.CreateWithJobAndReleaseStorageReservation(ctx, document, job, ownerID); err != nil {
		s.discardUpload(ctx, storagePath)
		return nil, apperror.Internal(err)
	}

	// Linked after the replacement exists, so a failure above never leaves the old
	// document pointing at a row that was not created. If this last step fails the
	// replacement is already a usable document -- the version link is what is
	// missing, and that is the smaller loss.
	if err := s.documents.MarkSuperseded(ctx, old.ID, document.ID, time.Now().UTC()); err != nil {
		if errors.Is(err, repository.ErrDocumentAlreadySuperseded) {
			return nil, apperror.New(
				http.StatusConflict,
				"DOCUMENT_ALREADY_SUPERSEDED",
				"该文档已被替换，请替换最新版本",
			)
		}
		return nil, apperror.Internal(err)
	}

	s.recordDocumentActivity(ctx, ownerID, ActivityDocumentUploaded, document)
	res := toDocumentResponse(document, job, s.maxDocumentRetries(), s.staleAfterDays())
	return &res, nil
}

// discardUpload removes a written object and the reservation that covered it. The
// reservation is only cancelled when the delete succeeded: if the object is still
// there, the reservation is what will eventually clean it up, so cancelling it on
// a failed delete is what would turn a stray object into a permanent one.
func (s *DocumentService) discardUpload(ctx context.Context, storagePath string) {
	if err := s.cleanupUploadedFile(ctx, storagePath); err != nil {
		return
	}
	s.cancelStorageReservation(ctx, storagePath)
}

// fileTypeOf is the extension without the dot, lowercased, matching what Upload
// stores so the two paths cannot disagree about a document's type.
func fileTypeOf(filename string) string {
	return strings.TrimPrefix(strings.ToLower(filepath.Ext(filename)), ".")
}
