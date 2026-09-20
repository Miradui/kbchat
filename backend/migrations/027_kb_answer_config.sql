ALTER TABLE knowledge_bases
    ADD COLUMN IF NOT EXISTS answer_config JSONB NOT NULL DEFAULT '{"answerLanguage":"auto","allowGeneralKnowledge":false,"model":""}';
