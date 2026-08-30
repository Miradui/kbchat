-- Adds what duplicate detection, version replacement, parse-error classification
-- and answer-status reporting need. All columns are nullable or defaulted with NO
-- backfill; see the per-column notes below for why each cannot be reconstructed.

-- content_hash is SHA-256 of the uploaded bytes, hex encoded.
--
-- Not backfilled: computing it for existing rows means re-reading every stored
-- object, which a schema migration must not do -- it would depend on object
-- storage being reachable and would run unbounded I/O inside a DDL transaction.
-- Existing documents therefore have NULL and never collide with a new upload,
-- which fails open (allow the upload) rather than closed (block a legitimate one).
--
-- superseded_by_id/superseded_at record that a document was replaced by a newer
-- version. NULL means current. The old row is kept: a replacement whose
-- processing fails must not leave the knowledge base with neither version.
--
-- error_code is the classified parse/processing failure. Not backfilled: the
-- original error text is all that exists for old rows, and re-deriving a code
-- from free text is exactly the string matching this column exists to remove.
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS superseded_by_id UUID,
    ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS error_code VARCHAR(32);

ALTER TABLE documents
DROP CONSTRAINT IF EXISTS documents_superseded_by_id_fkey;

ALTER TABLE documents
ADD CONSTRAINT documents_superseded_by_id_fkey
FOREIGN KEY (superseded_by_id) REFERENCES documents (id) ON DELETE SET NULL;

ALTER TABLE documents
DROP CONSTRAINT IF EXISTS documents_error_code_check;

ALTER TABLE documents
ADD CONSTRAINT documents_error_code_check CHECK (
    error_code IS NULL OR error_code IN (
        'unsupported_type',
        'corrupt_file',
        'encoding_invalid',
        'empty_content',
        'embedding_failed',
        'storage_failed',
        'cancelled',
        'internal'
    )
);

-- Serves the duplicate lookup: knowledge_base_id + content_hash on live rows.
--
-- Deliberately NOT unique. A user may explicitly choose to keep both copies of
-- the same content, and a unique index would make that choice impossible to
-- honour -- the API would have to reject an upload the user just confirmed.
-- Partial because NULL hashes (pre-migration rows) would only bloat it.
CREATE INDEX IF NOT EXISTS idx_documents_content_hash
ON documents (knowledge_base_id, content_hash)
WHERE deleted_at IS NULL AND content_hash IS NOT NULL;

-- answer_status distinguishes the three failure modes the roadmap asks for from a
-- normal answer:
--
--   answered         -- the model answered from retrieved context
--   no_basis         -- knowledge intent, retrieval succeeded but matched nothing
--   retrieval_failed -- retrieval itself errored (embedding or database failure)
--   model_refused    -- context was supplied and the model still declined
--
-- Nullable with NO backfill, for the same reason as intent in 018: answers
-- written before this migration have no recorded status, and deriving one from
-- the stored text would mean string-matching the refusal wording, which is
-- exactly what this column removes. Readers must exclude NULL rather than treat
-- it as answered.
ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS answer_status VARCHAR(32);

ALTER TABLE chat_messages
DROP CONSTRAINT IF EXISTS chat_messages_answer_status_check;

ALTER TABLE chat_messages
ADD CONSTRAINT chat_messages_answer_status_check CHECK (
    answer_status IS NULL OR answer_status IN (
        'answered',
        'no_basis',
        'retrieval_failed',
        'model_refused'
    )
);

-- Serves the knowledge-gap grouping by status over assistant messages. Partial
-- for the same reason as the 018 index: conversation answers and pre-migration
-- rows carry no status.
--
-- SQLite AutoMigrate does not reproduce this WHERE clause, so the test helper
-- creates it explicitly; see newChatServiceTestDB.
CREATE INDEX IF NOT EXISTS idx_chat_messages_answer_status
ON chat_messages (session_id, answer_status)
WHERE role = 'assistant' AND answer_status IS NOT NULL;
