-- Existing conversations retain their explicitly chosen scope.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS scope_mode varchar(16) NOT NULL DEFAULT 'manual';
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'chat_sessions'::regclass AND conname = 'chat_sessions_scope_mode_check') THEN
        ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_scope_mode_check CHECK (scope_mode IN ('auto', 'manual'));
    END IF;
END $$;
