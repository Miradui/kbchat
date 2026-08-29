-- Persist the intent classification and the canonical retrieval query that the
-- chat pipeline already computes per answer but previously discarded.
--
-- Without `intent`, "citations 为空的知识型回答" cannot be expressed: a
-- conversation-intent answer is deliberately given an empty citation array, so
-- counting empty citations alone conflates answers that should have sources with
-- answers that never should.
--
-- All three columns are deliberately nullable with NO backfill. Answers written
-- before this migration have no recorded intent and cannot be reclassified
-- without re-running the model, so guessing a value would fabricate operational
-- data. Readers must exclude NULL intent from intent-scoped metrics rather than
-- treating it as a zero.
ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS intent VARCHAR(32),
    ADD COLUMN IF NOT EXISTS retrieval_query TEXT,
    ADD COLUMN IF NOT EXISTS retrieval_query_norm TEXT;

ALTER TABLE chat_messages
DROP CONSTRAINT IF EXISTS chat_messages_intent_check;

ALTER TABLE chat_messages
ADD CONSTRAINT chat_messages_intent_check CHECK (
    intent IS NULL OR intent IN ('conversation', 'knowledge_base')
);

-- Serves the repeated-rewrite grouping: GROUP BY session_id,
-- retrieval_query_norm over assistant messages. Partial because conversation
-- answers and pre-migration rows have no normalized query and would only bloat
-- the index.
--
-- SQLite AutoMigrate does not reproduce this WHERE clause, so the test helper
-- creates it explicitly; see newChatServiceTestDB.
CREATE INDEX IF NOT EXISTS idx_chat_messages_retrieval_query_norm
ON chat_messages (session_id, retrieval_query_norm)
WHERE role = 'assistant' AND retrieval_query_norm IS NOT NULL;
