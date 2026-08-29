CREATE INDEX IF NOT EXISTS idx_chat_messages_negative_feedback
ON chat_messages (feedback_updated_at DESC, session_id)
WHERE role = 'assistant' AND feedback_rating = 'negative';
