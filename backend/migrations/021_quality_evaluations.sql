ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS feedback_reason VARCHAR(32) NOT NULL DEFAULT '';
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS feedback_comment TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS evaluation_cases (
    id UUID PRIMARY KEY,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id),
    question TEXT NOT NULL,
    expected_answer TEXT NOT NULL DEFAULT '',
    required_keywords JSONB NOT NULL DEFAULT '[]',
    require_citation BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evaluation_cases_knowledge_base_id ON evaluation_cases(knowledge_base_id);

CREATE TABLE IF NOT EXISTS evaluation_runs (
    id UUID PRIMARY KEY,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id),
    client_request_id UUID NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    name VARCHAR(80) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    config JSONB NOT NULL,
    cases JSONB NOT NULL,
    results JSONB NOT NULL DEFAULT '[]',
    runtime JSONB NOT NULL DEFAULT '{}',
    error_message TEXT NOT NULL DEFAULT '',
    lease_token UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_run_request ON evaluation_runs(knowledge_base_id, created_by, client_request_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_knowledge_base_id ON evaluation_runs(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_status ON evaluation_runs(status);
