package service

import (
	"context"
	"io"
	"mime/multipart"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/dto"
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
	options ...DocumentUploadOptions,
) (*dto.DocumentResponse, error) {
	old, err := s.authorizeDocument(ctx, ownerID, documentID, access.CapContentWrite)
	if err != nil {
		return nil, err
	}
	if err := s.validateFile(file); err != nil {
		return nil, err
	}
	var opts DocumentUploadOptions
	if len(options) > 0 {
		opts = options[0]
	}
	opts.replaces = &documentID
	return s.uploadSource(ctx, ownerID, old.KnowledgeBaseID, documentSource{
		Filename: file.Filename, Size: file.Size, Open: func() (io.ReadCloser, error) { return file.Open() },
	}, opts)
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
