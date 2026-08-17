-- Cross-knowledge-base document moves need both sides of the composite key to
-- change together. With a non-deferrable NO ACTION foreign key neither order
-- works: updating documents first orphans the existing chunk rows, and updating
-- the chunks first points them at a (document_id, knowledge_base_id) pair that
-- does not exist yet. Marking the constraint DEFERRABLE lets the move
-- transaction defer the check until both statements have run.
--
-- INITIALLY IMMEDIATE keeps the default behaviour for every other write path:
-- only the move transaction issues SET CONSTRAINTS ... DEFERRED.
ALTER TABLE document_chunks
DROP CONSTRAINT IF EXISTS fk_document_chunks_document_kb;

ALTER TABLE document_chunks
ADD CONSTRAINT fk_document_chunks_document_kb
FOREIGN KEY (document_id, knowledge_base_id)
REFERENCES documents (id, knowledge_base_id)
ON DELETE CASCADE
DEFERRABLE INITIALLY IMMEDIATE;
