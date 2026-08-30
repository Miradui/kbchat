package service

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/model"
)

// hashUploadedFile returns the hex-encoded SHA-256 of an upload's bytes.
//
// The hash is computed in the service rather than inside Storage. Threading it
// through the Storage interface would change every backend and every test fake to
// carry a value only one caller wants, and would put a content-identity concern
// inside the layer whose job is byte transport.
//
// This does read the upload twice. multipart.FileHeader.Open re-reads from memory
// for small files and from the request's spooled temp file for large ones, so the
// second pass is local, never a network round trip -- the file has not reached
// object storage at this point. Hashing before the upload also means a duplicate
// is rejected without writing anything, which is the cheaper failure.
func hashUploadedFile(file *multipart.FileHeader) (string, error) {
	if file == nil {
		return "", fmt.Errorf("hash upload: no file")
	}
	reader, err := file.Open()
	if err != nil {
		return "", fmt.Errorf("open upload for hashing: %w", err)
	}
	defer reader.Close()

	digest := sha256.New()
	if _, err := io.Copy(digest, reader); err != nil {
		return "", fmt.Errorf("read upload for hashing: %w", err)
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// newDuplicateDocumentError describes the conflict well enough for the client to
// offer a choice: which document already holds this content, and when it arrived.
// The status is 409 rather than 400 because the request is well formed -- the
// server is refusing it on the current state of the knowledge base, and the same
// request with allowDuplicate set will succeed.
//
// Retrying is a decision, so the details name the existing document instead of
// only reporting that one exists. The storage path is deliberately absent: it is
// deployment topology, and the client never needs it to render the dialog.
func newDuplicateDocumentError(existing *model.Document) *apperror.Error {
	e := apperror.New(http.StatusConflict, "DOCUMENT_DUPLICATE_CONTENT", "知识库中已存在内容相同的文档")
	e.Details = map[string]any{
		"existingDocumentId": existing.ID.String(),
		"existingFilename":   existing.Filename,
		"existingStatus":     existing.Status,
		"existingUploadedAt": existing.CreatedAt,
	}
	return e
}
