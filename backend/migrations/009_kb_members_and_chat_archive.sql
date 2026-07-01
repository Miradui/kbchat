CREATE TABLE IF NOT EXISTS knowledge_base_members (
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    PRIMARY KEY (knowledge_base_id, user_id),
    CONSTRAINT knowledge_base_members_role_check CHECK (role IN ('manager', 'member'))
);

CREATE INDEX IF NOT EXISTS idx_kb_members_user_id ON knowledge_base_members (user_id);
CREATE INDEX IF NOT EXISTS idx_kb_members_role ON knowledge_base_members (role);

ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;

ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_deleted_at ON chat_sessions (deleted_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived_at ON chat_sessions (archived_at);
