CREATE TABLE IF NOT EXISTS storage_cleanup_jobs (
    id UUID PRIMARY KEY,
    storage_path TEXT NOT NULL,
    retry_count INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP NULL,
    locked_at TIMESTAMP NULL,
    lease_token UUID NULL,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now()
);

ALTER TABLE storage_cleanup_jobs
ADD COLUMN IF NOT EXISTS lease_token UUID NULL;

CREATE INDEX IF NOT EXISTS idx_storage_cleanup_jobs_next_attempt_at
ON storage_cleanup_jobs (next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_storage_cleanup_jobs_locked_at
ON storage_cleanup_jobs (locked_at);

CREATE INDEX IF NOT EXISTS idx_storage_cleanup_jobs_lease_token
ON storage_cleanup_jobs (lease_token);

CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_cleanup_jobs_storage_path
ON storage_cleanup_jobs (storage_path);
