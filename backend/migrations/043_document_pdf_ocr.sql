CREATE TABLE IF NOT EXISTS document_pdf_snapshots (
 document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 content JSONB NOT NULL
);
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_error_code_check;
ALTER TABLE documents ADD CONSTRAINT documents_error_code_check CHECK (
 error_code IS NULL OR error_code IN ('unsupported_type','corrupt_file','encoding_invalid','empty_content','embedding_failed','storage_failed','cancelled','internal','table_limit_exceeded','table_import_invalid','pdf_limit_exceeded','ocr_unavailable','ocr_timeout','ocr_failed','ocr_limit_exceeded')
);
