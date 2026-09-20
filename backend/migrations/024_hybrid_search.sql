-- Hybrid retrieval: keyword lexemes next to the embedding, and HNSW in place of
-- ivfflat for the vector index.
--
-- search_vector holds lexemes produced by backend/internal/document/lexer, not
-- by a PostgreSQL text-search parser, so the column is written by the
-- application and is NULL for chunks indexed before this migration. Run
-- `go run ./cmd/reindex-keywords` afterwards to populate existing rows; chunks
-- stay retrievable by vector in the meantime and simply do not participate in
-- keyword recall until reindexed.
--
-- Re-runnable. Building the HNSW index reads the whole table; on large tables
-- raise `-timeout` on cmd/migrate and consider a higher maintenance_work_mem
-- for the session.

ALTER TABLE document_chunks
ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_chunks_search_vector
ON document_chunks
USING gin (search_vector);

DROP INDEX IF EXISTS idx_chunks_embedding;

CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
ON document_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
