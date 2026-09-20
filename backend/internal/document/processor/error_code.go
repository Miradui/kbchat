package processor

import (
	"context"
	"errors"

	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/storage"
)

// The closed set written to documents.error_code. Kept in sync with the CHECK
// constraint in migrations/019_document_versions_and_answer_status.sql -- adding a
// value here without the migration makes every write of it fail.
const (
	// ErrorCodeUnsupportedType is part of the closed set but ClassifyError never
	// returns it: upload validation rejects unsupported extensions or file magic with a 400
	// before a document row exists, so processing never sees one. It stays defined
	// so the Go side and the CHECK constraint list the same values.
	ErrorCodeUnsupportedType = "unsupported_type"
	ErrorCodeCorruptFile     = "corrupt_file"
	ErrorCodeEncodingInvalid = "encoding_invalid"
	ErrorCodeEmptyContent    = "empty_content"
	ErrorCodeEmbeddingFailed = "embedding_failed"
	ErrorCodeStorageFailed   = "storage_failed"
	ErrorCodeCancelled       = "cancelled"
	ErrorCodeInternal        = "internal"
)

// ClassifyError maps a processing failure to the closed set above.
//
// This exists so the user gets advice instead of a stack trace: "this PDF has no
// text layer, try OCR" is actionable, "parse pdf page 3: EOF" is not. The raw
// error still goes to the job's error_message and the server log -- the code is
// an addition, not a replacement.
//
// Unrecognised errors are deliberately ErrorCodeInternal rather than a guess. A
// wrong specific code sends the user to fix the wrong thing, which is worse than
// admitting the server does not know.
func ClassifyError(err error) string {
	if err == nil {
		return ""
	}

	switch {
	// Cancellation is checked first: a cancel can surface as a wrapped provider or
	// storage failure, and calling that "embedding failed" would send the user
	// chasing a provider that was never broken.
	case errors.Is(err, context.Canceled),
		errors.Is(err, context.DeadlineExceeded),
		errors.Is(err, repository.ErrDocumentJobCancelled):
		return ErrorCodeCancelled
	case errors.Is(err, parser.ErrEncodingInvalid):
		return ErrorCodeEncodingInvalid
	case errors.Is(err, parser.ErrCorruptFile):
		return ErrorCodeCorruptFile
	case errors.Is(err, ErrEmptyContent):
		return ErrorCodeEmptyContent
	case errors.Is(err, ErrStorageFailed), errors.Is(err, storage.ErrNotFound):
		return ErrorCodeStorageFailed
	case errors.Is(err, ErrEmbeddingFailed):
		return ErrorCodeEmbeddingFailed
	default:
		return ErrorCodeInternal
	}
}
