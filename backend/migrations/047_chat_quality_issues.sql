CREATE TABLE IF NOT EXISTS chat_quality_issues (
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
 question_key VARCHAR(64) NOT NULL,
 question TEXT NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','retest','resolved')),
 note TEXT NOT NULL DEFAULT '',
 evaluation_case_id UUID REFERENCES evaluation_cases(id) ON DELETE SET NULL,
 evaluation_run_id UUID REFERENCES evaluation_runs(id) ON DELETE SET NULL,
 document_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (user_id, session_id, question_key)
);
