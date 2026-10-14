ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_path TEXT NOT NULL DEFAULT '';
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_path_length;
ALTER TABLE documents ADD CONSTRAINT documents_source_path_length CHECK (octet_length(source_path) <= 1024);
