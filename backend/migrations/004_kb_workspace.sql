CREATE TABLE IF NOT EXISTS knowledge_base_categories (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id),
    parent_id UUID REFERENCES knowledge_base_categories(id) ON DELETE RESTRICT,
    name VARCHAR(128) NOT NULL,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES knowledge_base_categories(id) ON DELETE SET NULL;

ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS visibility VARCHAR(32) NOT NULL DEFAULT 'private';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_bases_visibility_check'
    ) THEN
        ALTER TABLE knowledge_bases
        ADD CONSTRAINT knowledge_bases_visibility_check CHECK (visibility IN ('private', 'public'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS knowledge_base_favorites (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT now(),
    PRIMARY KEY (user_id, knowledge_base_id)
);

CREATE TABLE IF NOT EXISTS knowledge_base_view_events (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    viewed_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_categories_owner_id ON knowledge_base_categories (owner_id);
CREATE INDEX IF NOT EXISTS idx_kb_categories_parent_id ON knowledge_base_categories (parent_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_category_id ON knowledge_bases (category_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_visibility ON knowledge_bases (visibility);
CREATE INDEX IF NOT EXISTS idx_kb_favorites_user_id ON knowledge_base_favorites (user_id);
CREATE INDEX IF NOT EXISTS idx_kb_favorites_kb_id ON knowledge_base_favorites (knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_kb_view_events_user_id ON knowledge_base_view_events (user_id);
CREATE INDEX IF NOT EXISTS idx_kb_view_events_kb_id ON knowledge_base_view_events (knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_kb_view_events_viewed_at ON knowledge_base_view_events (viewed_at);
