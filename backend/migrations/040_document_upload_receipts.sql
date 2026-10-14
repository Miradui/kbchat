CREATE TABLE IF NOT EXISTS document_upload_receipts (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    fingerprint VARCHAR(64) NOT NULL,
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, knowledge_base_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_document_upload_receipts_document_id ON document_upload_receipts(document_id);
