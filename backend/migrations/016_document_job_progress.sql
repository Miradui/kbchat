ALTER TABLE document_jobs
ADD COLUMN IF NOT EXISTS progress SMALLINT NOT NULL DEFAULT 0;

UPDATE document_jobs AS jobs
SET progress = CASE
    WHEN jobs.status = 'completed' THEN 100
    WHEN documents.status = 'embedding' THEN 50
    WHEN documents.status = 'chunking' THEN 30
    WHEN documents.status = 'parsing' THEN 10
    ELSE 0
END
FROM documents
WHERE documents.id = jobs.document_id
  AND jobs.progress = 0;

ALTER TABLE document_jobs
DROP CONSTRAINT IF EXISTS document_jobs_progress_check;

ALTER TABLE document_jobs
ADD CONSTRAINT document_jobs_progress_check CHECK (progress BETWEEN 0 AND 100);
