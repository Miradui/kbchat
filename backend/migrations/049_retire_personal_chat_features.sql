-- Personal question templates and branch creation have been retired.
-- Existing branch sessions, their transcripts and source links remain readable.
-- Apply after stopping the old backend and backing up any template data needed
-- for rollback. The migration runner wraps selected files in a transaction.
DROP TABLE IF EXISTS question_templates;
ALTER TABLE chat_sessions DROP COLUMN IF EXISTS branch_request_id;
