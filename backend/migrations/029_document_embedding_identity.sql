-- Historical vectors remain unknown until a document is reprocessed.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(128);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER;
