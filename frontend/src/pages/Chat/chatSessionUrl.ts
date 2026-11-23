/** Carry the history filter independently of the destination session's scope. */
export function chatSessionUrl(sessionId: string, knowledgeBaseId = '', messageId = '') {
  const params = new URLSearchParams();
  if (knowledgeBaseId) params.set('knowledgeBaseId', knowledgeBaseId);
  if (messageId) params.set('messageId', messageId);
  const query = params.toString();
  return `/chat/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`;
}
