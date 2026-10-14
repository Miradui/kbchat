-- Reverse lookups in a replacement chain must not scan the whole library.
CREATE INDEX IF NOT EXISTS idx_documents_superseded_by ON documents (superseded_by_id) WHERE superseded_by_id IS NOT NULL;
