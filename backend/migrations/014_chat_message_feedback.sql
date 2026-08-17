ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS feedback_rating VARCHAR(16),
    ADD COLUMN IF NOT EXISTS feedback_updated_at TIMESTAMP;

ALTER TABLE chat_messages
DROP CONSTRAINT IF EXISTS chat_messages_feedback_rating_check;

ALTER TABLE chat_messages
ADD CONSTRAINT chat_messages_feedback_rating_check CHECK (
    feedback_rating IS NULL OR feedback_rating IN ('positive', 'negative')
);
