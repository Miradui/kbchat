ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS document_version_policy VARCHAR(16) NOT NULL DEFAULT 'all';
ALTER TABLE knowledge_bases DROP CONSTRAINT IF EXISTS knowledge_bases_document_version_policy_check;
ALTER TABLE knowledge_bases ADD CONSTRAINT knowledge_bases_document_version_policy_check CHECK (document_version_policy IN ('all', 'current'));
