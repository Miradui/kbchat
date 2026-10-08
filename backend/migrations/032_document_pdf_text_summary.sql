-- Existing documents stay unknown until explicitly reprocessed. No model calls or
-- content backfill run during migration.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pdf_text_summary JSONB;
