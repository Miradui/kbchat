ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;

ALTER TABLE documents
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_bases_deleted_at ON knowledge_bases (deleted_at);
CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents (deleted_at);
