CREATE TABLE IF NOT EXISTS chat_bookmarks (
    message_id UUID PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 4000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_bookmarks_user_created ON chat_bookmarks(user_id, created_at DESC, message_id DESC);
