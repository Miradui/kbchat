export type ChatDocument = { id: string; knowledgeBaseId: string; filename: string };

export function documentChatUrl(documents: ChatDocument[], question?: string) {
  const ids = [...new Set(documents.map((document) => document.id))];
  const bases = [...new Set(documents.map((document) => document.knowledgeBaseId))];
  if (!ids.length || ids.length > 20 || bases.length > 5) throw new Error('请选择最多 5 个知识库中的 1–20 份文档。');
  const params = new URLSearchParams({ knowledgeBaseId: bases[0], documentIds: ids.join(',') });
  if (bases.length > 1) params.set('knowledgeBaseIds', bases.join(','));
  if (question) params.set('q', question);
  return `/chat?${params}`;
}
