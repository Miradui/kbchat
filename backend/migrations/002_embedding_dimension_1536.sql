DROP INDEX IF EXISTS idx_chunks_embedding;

ALTER TABLE document_chunks
ALTER COLUMN embedding TYPE vector(1536);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding
ON document_chunks
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
