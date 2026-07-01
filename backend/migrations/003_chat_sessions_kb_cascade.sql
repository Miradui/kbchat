ALTER TABLE chat_sessions
DROP CONSTRAINT IF EXISTS chat_sessions_knowledge_base_id_fkey;

ALTER TABLE chat_sessions
ADD CONSTRAINT chat_sessions_knowledge_base_id_fkey
FOREIGN KEY (knowledge_base_id)
REFERENCES knowledge_bases(id)
ON DELETE CASCADE;
