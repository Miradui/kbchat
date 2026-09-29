-- Existing sessions remain single-base; additional bases are fixed at creation.
CREATE TABLE IF NOT EXISTS chat_session_knowledge_bases (
    session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE RESTRICT,
    PRIMARY KEY (session_id, knowledge_base_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_session_knowledge_bases_knowledge_base_id
    ON chat_session_knowledge_bases (knowledge_base_id);
