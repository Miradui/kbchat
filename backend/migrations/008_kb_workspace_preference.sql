CREATE TABLE knowledge_base_workspace_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    view_mode VARCHAR(32) NOT NULL DEFAULT 'table',
    scope VARCHAR(32) NOT NULL DEFAULT 'all',
    sort VARCHAR(32) NOT NULL DEFAULT 'updatedAt_desc',
    visibility VARCHAR(32) NOT NULL DEFAULT 'all',
    expanded_category_ids JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now()
);

