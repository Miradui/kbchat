package repository

// A document is current for retrieval until a same-library successor actually
// has a published snapshot. Walking through soft-deleted intermediate versions
// preserves a chain; moving or permanently deleting a link ends that chain.
// UNION terminates malformed cycles. Historical chunk reads do not use this
// predicate, so old citations and comparisons remain available.
const documentVersionSearchCondition = `(knowledge_bases.document_version_policy = 'all' OR NOT EXISTS (
 WITH RECURSIVE newer_versions AS (
  SELECT next.id, next.superseded_by_id, next.deleted_at
  FROM documents next
  WHERE next.id = documents.superseded_by_id AND next.knowledge_base_id = documents.knowledge_base_id
  UNION
  SELECT next.id, next.superseded_by_id, next.deleted_at
  FROM documents next JOIN newer_versions previous ON next.id = previous.superseded_by_id
  WHERE next.knowledge_base_id = documents.knowledge_base_id
 )
 SELECT 1 FROM newer_versions newer
 JOIN document_chunks published ON published.document_id = newer.id AND published.knowledge_base_id = documents.knowledge_base_id
 WHERE newer.deleted_at IS NULL AND newer.id <> documents.id
))`
