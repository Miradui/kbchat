-- Allow the terminal state written by POST /documents/:id/cancel.
--
-- SQLite AutoMigrate tests do not recreate this PostgreSQL CHECK constraint,
-- so the cancellation path can pass locally while production rejects the row
-- update unless the existing constraint is replaced explicitly.
ALTER TABLE document_jobs
DROP CONSTRAINT IF EXISTS document_jobs_status_check;

ALTER TABLE document_jobs
ADD CONSTRAINT document_jobs_status_check CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
);
