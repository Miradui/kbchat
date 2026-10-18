ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS document_scope JSONB NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_sessions_document_scope_array' AND conrelid = 'chat_sessions'::regclass) THEN
    ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_document_scope_array CHECK (jsonb_typeof(document_scope) = 'array' AND jsonb_array_length(document_scope) <= 20);
  END IF;
END $$;
