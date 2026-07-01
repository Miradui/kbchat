ALTER TABLE users
ADD COLUMN IF NOT EXISTS avatar_url TEXT;

ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS updated_by_id UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE knowledge_bases
SET updated_by_id = owner_id
WHERE updated_by_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_bases_updated_by_id ON knowledge_bases (updated_by_id);
