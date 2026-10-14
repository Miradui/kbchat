ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS branch_from_session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS branch_from_message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS branch_request_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_branch_request ON chat_sessions(branch_request_id) WHERE branch_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_branch_from_session_id ON chat_sessions(branch_from_session_id);
