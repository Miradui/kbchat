-- Activity feed for the workspace timeline.
--
-- The home page used to merge three lists client side, which can only ever show
-- things that still exist; deletions, restores and membership changes were
-- invisible. This table records the events themselves.
--
-- resource_name and knowledge_base_name are denormalised on purpose: an entry
-- has to stay readable after the resource it refers to is permanently deleted,
-- so there is deliberately no foreign key to the resource tables.
CREATE TABLE IF NOT EXISTS activities (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    action VARCHAR(64) NOT NULL,
    resource_type VARCHAR(32) NOT NULL,
    resource_id UUID NOT NULL,
    resource_name VARCHAR(255) NOT NULL DEFAULT '',
    knowledge_base_id UUID,
    knowledge_base_name VARCHAR(128) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The only read pattern is "this user's newest N", so index for exactly that.
CREATE INDEX IF NOT EXISTS idx_activities_user_created_at
ON activities (user_id, created_at DESC, id DESC);
