CREATE TABLE IF NOT EXISTS knowledge_base_tags (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_kb_tags_owner_name
ON knowledge_base_tags (owner_id, name);

CREATE TABLE IF NOT EXISTS knowledge_base_tag_bindings (
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES knowledge_base_tags(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT now(),
    PRIMARY KEY (knowledge_base_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_tags_owner_id ON knowledge_base_tags (owner_id);
CREATE INDEX IF NOT EXISTS idx_kb_tag_bindings_kb_id ON knowledge_base_tag_bindings (knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_kb_tag_bindings_tag_id ON knowledge_base_tag_bindings (tag_id);
