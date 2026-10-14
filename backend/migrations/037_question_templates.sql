CREATE TABLE IF NOT EXISTS question_templates (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title VARCHAR(100) NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
 body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 12000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_question_templates_user_updated ON question_templates(user_id, updated_at DESC, id DESC);
