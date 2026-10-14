package processor

import (
	"context"
	"errors"

	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/tableconfig"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/storage"
)

// The closed set written to documents.error_code. Kept in sync with the CHECK
// constraint in migrations/041_document_table_import.sql -- adding a
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
	ErrorCodeTableLimit      = "table_limit_exceeded"
	ErrorCodeTableImport     = "table_import_invalid"
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
	case errors.Is(err, parser.ErrTableLimit):
		return ErrorCodeTableLimit
	case errors.Is(err, tableconfig.ErrInvalid):
		return ErrorCodeTableImport
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

// IsPermanent reports whether running the same job again cannot succeed: the
// file itself is unreadable, not UTF-8, has no extractable text, or the stored
// object is gone. The worker fails these on the first attempt instead of
// spending its retry budget and making the user wait for the same verdict.
// Provider, storage-read and unrecognised failures stay retryable.
func IsPermanent(err error) bool {
	switch ClassifyError(err) {
	case ErrorCodeEncodingInvalid, ErrorCodeCorruptFile, ErrorCodeEmptyContent, ErrorCodeTableLimit, ErrorCodeTableImport:
		return true
	case ErrorCodeStorageFailed:
		return errors.Is(err, storage.ErrNotFound)
	default:
		return false
	}
}
