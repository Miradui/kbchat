-- Preserve the enqueue span across process restarts and job retries. No baggage
-- or request content is stored in telemetry context.
ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS traceparent VARCHAR(55) NOT NULL DEFAULT '';
