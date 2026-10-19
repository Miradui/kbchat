-- The chat pipeline gained a third intent: a question about general concepts or
-- public knowledge is answered without retrieval, because the knowledge base is
-- not expected to cover it. Without this value the first such answer fails at
-- write time -- after the model has already produced and streamed it.
--
-- The constraint is dropped and re-added rather than altered: PostgreSQL has no
-- ALTER CONSTRAINT for a CHECK expression, and dropping by name keeps this
-- migration runnable on a database that already applied 018.
ALTER TABLE chat_messages
    DROP CONSTRAINT IF EXISTS chat_messages_intent_check;

ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_intent_check CHECK (
        intent IS NULL OR intent IN ('conversation', 'general', 'knowledge_base')
    );
