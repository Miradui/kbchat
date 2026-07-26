ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS client_request_id UUID,
    ADD COLUMN IF NOT EXISTS rerank_fallback JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_session_client_role
    ON chat_messages(session_id, client_request_id, role)
    WHERE client_request_id IS NOT NULL AND role IN ('user', 'assistant');
