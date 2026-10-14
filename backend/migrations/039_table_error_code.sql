ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_error_code_check;
ALTER TABLE documents ADD CONSTRAINT documents_error_code_check CHECK (
 error_code IS NULL OR error_code IN ('unsupported_type','corrupt_file','encoding_invalid','empty_content','embedding_failed','storage_failed','cancelled','internal','table_limit_exceeded')
);
