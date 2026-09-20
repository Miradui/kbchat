-- P4 system user administration. Existing users remain active and retain all
-- data; disabling is deliberately a reversible status change, not a delete.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_by UUID;

UPDATE users SET status = 'active' WHERE status IS NULL OR status = '';

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_status_check;

ALTER TABLE users
    ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'));

CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
CREATE INDEX IF NOT EXISTS idx_users_created_by ON users (created_by);

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_created_by_fkey;

ALTER TABLE users
    ADD CONSTRAINT users_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL;
