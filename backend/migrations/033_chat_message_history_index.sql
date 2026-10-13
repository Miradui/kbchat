-- Supports stable keyset reads of a session's message history without sorting
-- every message before returning the latest page. Existing content is unchanged.
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_order ON chat_messages (session_id, created_at, id);
