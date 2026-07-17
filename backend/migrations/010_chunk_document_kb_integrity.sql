CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_id_kb_id
ON documents (id, knowledge_base_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_document_chunks_document_kb'
          AND conrelid = 'document_chunks'::regclass
    ) THEN
        ALTER TABLE document_chunks
        ADD CONSTRAINT fk_document_chunks_document_kb
        FOREIGN KEY (document_id, knowledge_base_id)
        REFERENCES documents (id, knowledge_base_id)
        ON DELETE CASCADE;
    END IF;
END
$$;
