import { apiBlobRequest, apiRequest } from './client';
import type {
  BatchResultResponse,
  ChatMessageListResponse,
  ChatSession,
  ChatSessionListResponse,
  DocumentChunkListResponse,
  DocumentChunkListParams,
  DocumentItem,
  DocumentListResponse,
  DocumentPreviewResponse,
  GlobalDocumentListParams,
  GlobalDocumentListResponse,
  GlobalSearchResponse,
  KnowledgeBase,
  KnowledgeBaseCategory,
  KnowledgeBaseCategoryInput,
  KnowledgeBaseCategoryListResponse,
  KnowledgeBaseCategoryReorderItem,
  KnowledgeBaseInput,
  KnowledgeBaseListResponse,
  KnowledgeBaseListParams,
  KnowledgeBasePermissionResponse,
  KnowledgeBaseSearchRequest,
  KnowledgeBaseSearchResponse,
  KnowledgeBaseTag,
  KnowledgeBaseTagInput,
  KnowledgeBaseStatsResponse,
  KnowledgeBaseTagListResponse,
  KnowledgeBaseWorkspacePreference,
  LoginResponse,
  MemberRole,
  RecycleBinListResponse,
  SendChatMessageResponse,
  User,
  UserSearchResponse,
} from '../types/api';

export function login(username: string, password: string): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { username, password },
  });
}

export function logout(): Promise<void> {
  return apiRequest<void>('/auth/logout', {
    method: 'POST',
  });
}

export function getCurrentUser(): Promise<User> {
  return apiRequest<User>('/auth/me');
}

export function listKnowledgeBases(params: KnowledgeBaseListParams = {}): Promise<KnowledgeBaseListResponse> {
  return apiRequest<KnowledgeBaseListResponse>(withQuery('/knowledge-bases', params));
}

export function getKnowledgeBase(id: string): Promise<KnowledgeBase> {
  return apiRequest<KnowledgeBase>(`/knowledge-bases/${id}`);
}

export function createKnowledgeBase(input: KnowledgeBaseInput): Promise<KnowledgeBase> {
  return apiRequest<KnowledgeBase>('/knowledge-bases', {
    method: 'POST',
    body: input,
  });
}

export function updateKnowledgeBase(id: string, input: KnowledgeBaseInput): Promise<KnowledgeBase> {
  return apiRequest<KnowledgeBase>(`/knowledge-bases/${id}`, {
    method: 'PUT',
    body: input,
  });
}

export function deleteKnowledgeBase(id: string): Promise<void> {
  return apiRequest<void>(`/knowledge-bases/${id}`, {
    method: 'DELETE',
  });
}

export function listKnowledgeBaseCategories(): Promise<KnowledgeBaseCategoryListResponse> {
  return apiRequest<KnowledgeBaseCategoryListResponse>('/knowledge-base-categories');
}

export function createKnowledgeBaseCategory(
  input: KnowledgeBaseCategoryInput,
): Promise<KnowledgeBaseCategory> {
  return apiRequest<KnowledgeBaseCategory>('/knowledge-base-categories', {
    method: 'POST',
    body: input,
  });
}

export function updateKnowledgeBaseCategory(
  id: string,
  input: KnowledgeBaseCategoryInput,
): Promise<KnowledgeBaseCategory> {
  return apiRequest<KnowledgeBaseCategory>(`/knowledge-base-categories/${id}`, {
    method: 'PUT',
    body: input,
  });
}

export function deleteKnowledgeBaseCategory(id: string): Promise<void> {
  return apiRequest<void>(`/knowledge-base-categories/${id}`, {
    method: 'DELETE',
  });
}

export function reorderKnowledgeBaseCategories(
  items: KnowledgeBaseCategoryReorderItem[],
): Promise<BatchResultResponse> {
  return apiRequest<BatchResultResponse>('/knowledge-base-categories/reorder', {
    method: 'POST',
    body: { items },
  });
}

export function listKnowledgeBaseTags(): Promise<KnowledgeBaseTagListResponse> {
  return apiRequest<KnowledgeBaseTagListResponse>('/knowledge-base-tags');
}

export function createKnowledgeBaseTag(input: KnowledgeBaseTagInput): Promise<KnowledgeBaseTag> {
  return apiRequest<KnowledgeBaseTag>('/knowledge-base-tags', {
    method: 'POST',
    body: input,
  });
}

export function updateKnowledgeBaseTag(
  id: string,
  input: KnowledgeBaseTagInput,
): Promise<KnowledgeBaseTag> {
  return apiRequest<KnowledgeBaseTag>(`/knowledge-base-tags/${id}`, {
    method: 'PUT',
    body: input,
  });
}

export function deleteKnowledgeBaseTag(id: string): Promise<void> {
  return apiRequest<void>(`/knowledge-base-tags/${id}`, {
    method: 'DELETE',
  });
}

export function getKnowledgeBaseStats(period: 'day' | 'month' = 'month'): Promise<KnowledgeBaseStatsResponse> {
  return apiRequest<KnowledgeBaseStatsResponse>(`/knowledge-bases/stats?period=${period}`);
}

export function getWorkspacePreference(): Promise<KnowledgeBaseWorkspacePreference> {
  return apiRequest<KnowledgeBaseWorkspacePreference>('/knowledge-bases/workspace-preference');
}

export function updateWorkspacePreference(
  input: KnowledgeBaseWorkspacePreference,
): Promise<KnowledgeBaseWorkspacePreference> {
  return apiRequest<KnowledgeBaseWorkspacePreference>('/knowledge-bases/workspace-preference', {
    method: 'PUT',
    body: input,
  });
}

export function favoriteKnowledgeBase(id: string): Promise<void> {
  return apiRequest<void>(`/knowledge-bases/${id}/favorite`, {
    method: 'POST',
  });
}

export function unfavoriteKnowledgeBase(id: string): Promise<void> {
  return apiRequest<void>(`/knowledge-bases/${id}/favorite`, {
    method: 'DELETE',
  });
}

export function recordKnowledgeBaseView(id: string): Promise<void> {
  return apiRequest<void>(`/knowledge-bases/${id}/view`, {
    method: 'POST',
  });
}

export function batchFavoriteKnowledgeBases(ids: string[], favorite: boolean): Promise<BatchResultResponse> {
  return apiRequest<BatchResultResponse>('/knowledge-bases/batch-favorite', {
    method: 'POST',
    body: { knowledgeBaseIds: ids, favorite },
  });
}

export function batchDeleteKnowledgeBases(ids: string[]): Promise<BatchResultResponse> {
  return apiRequest<BatchResultResponse>('/knowledge-bases/batch-delete', {
    method: 'POST',
    body: { knowledgeBaseIds: ids },
  });
}

export function restoreKnowledgeBase(id: string): Promise<void> {
  return apiRequest<void>(`/knowledge-bases/${id}/restore`, {
    method: 'POST',
  });
}

export function batchRestoreKnowledgeBases(ids: string[]): Promise<BatchResultResponse> {
  return apiRequest<BatchResultResponse>('/knowledge-bases/batch-restore', {
    method: 'POST',
    body: { knowledgeBaseIds: ids },
  });
}

export function batchMoveKnowledgeBases(
  ids: string[],
  categoryId: string | null,
): Promise<BatchResultResponse> {
  return apiRequest<BatchResultResponse>('/knowledge-bases/batch-move-category', {
    method: 'POST',
    body: { knowledgeBaseIds: ids, categoryId },
  });
}

export function listKnowledgeBaseRecycleBin(page = 1, pageSize = 20): Promise<RecycleBinListResponse> {
  return apiRequest<RecycleBinListResponse>(
    withQuery('/knowledge-bases/recycle-bin', { page, pageSize }),
  );
}

export function deleteKnowledgeBasePermanently(id: string): Promise<void> {
  return apiRequest<void>(`/knowledge-bases/recycle-bin/${id}`, {
    method: 'DELETE',
  });
}

export function emptyKnowledgeBaseRecycleBin(): Promise<void> {
  return apiRequest<void>('/knowledge-bases/recycle-bin/empty', {
    method: 'POST',
  });
}

export function getKnowledgeBasePermissions(id: string): Promise<KnowledgeBasePermissionResponse> {
  return apiRequest<KnowledgeBasePermissionResponse>(`/knowledge-bases/${id}/permissions`);
}

export function updateKnowledgeBasePermissions(
  id: string,
  visibility: 'private' | 'public',
): Promise<KnowledgeBasePermissionResponse> {
  return apiRequest<KnowledgeBasePermissionResponse>(`/knowledge-bases/${id}/permissions`, {
    method: 'PUT',
    body: { visibility },
  });
}

export function searchUsers(q: string, limit = 20): Promise<UserSearchResponse> {
  return apiRequest<UserSearchResponse>(withQuery('/users/search', { q, limit }));
}

export function addKnowledgeBaseMember(
  id: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  return apiRequest<void>(`/knowledge-bases/${id}/members`, {
    method: 'POST',
    body: { userId, role },
  });
}

export function updateKnowledgeBaseMember(
  id: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  return apiRequest<void>(`/knowledge-bases/${id}/members/${userId}`, {
    method: 'PUT',
    body: { role },
  });
}

export function deleteKnowledgeBaseMember(id: string, userId: string): Promise<void> {
  return apiRequest<void>(`/knowledge-bases/${id}/members/${userId}`, {
    method: 'DELETE',
  });
}

export function listDocuments(knowledgeBaseId: string): Promise<DocumentListResponse> {
  return apiRequest<DocumentListResponse>(`/knowledge-bases/${knowledgeBaseId}/documents`);
}

export function listGlobalDocuments(
  params: GlobalDocumentListParams = {},
): Promise<GlobalDocumentListResponse> {
  return apiRequest<GlobalDocumentListResponse>(withQuery('/documents', params));
}

export function getDocument(id: string): Promise<DocumentItem> {
  return apiRequest<DocumentItem>(`/documents/${id}`);
}

export function getDocumentPreview(id: string): Promise<DocumentPreviewResponse> {
  return apiRequest<DocumentPreviewResponse>(`/documents/${id}/preview`);
}

export function downloadDocument(id: string): Promise<Blob> {
  return apiBlobRequest(`/documents/${id}/download`);
}

export function listDocumentChunks(
  id: string,
  params: DocumentChunkListParams = {},
): Promise<DocumentChunkListResponse> {
  return apiRequest<DocumentChunkListResponse>(
    withQuery(`/documents/${id}/chunks`, params),
  );
}

export function uploadDocument(knowledgeBaseId: string, file: File): Promise<DocumentItem> {
  const body = new FormData();
  body.append('file', file);

  return apiRequest<DocumentItem>(`/knowledge-bases/${knowledgeBaseId}/documents`, {
    method: 'POST',
    body,
  });
}

export function uploadGlobalDocument(knowledgeBaseId: string, file: File): Promise<DocumentItem> {
  const body = new FormData();
  body.append('knowledgeBaseId', knowledgeBaseId);
  body.append('file', file);

  return apiRequest<DocumentItem>('/documents', {
    method: 'POST',
    body,
  });
}

export function deleteDocument(id: string): Promise<void> {
  return apiRequest<void>(`/documents/${id}`, {
    method: 'DELETE',
  });
}

export function reprocessDocument(id: string): Promise<DocumentItem> {
  return apiRequest<DocumentItem>(`/documents/${id}/reprocess`, {
    method: 'POST',
  });
}

export function restoreDocument(id: string): Promise<void> {
  return apiRequest<void>(`/documents/${id}/restore`, {
    method: 'POST',
  });
}

export function batchDeleteDocuments(ids: string[]): Promise<BatchResultResponse> {
  return apiRequest<BatchResultResponse>('/documents/batch-delete', {
    method: 'POST',
    body: { documentIds: ids },
  });
}

export function batchRestoreDocuments(ids: string[]): Promise<BatchResultResponse> {
  return apiRequest<BatchResultResponse>('/documents/batch-restore', {
    method: 'POST',
    body: { documentIds: ids },
  });
}

export function batchReprocessDocuments(ids: string[]): Promise<BatchResultResponse> {
  return apiRequest<BatchResultResponse>('/documents/batch-reprocess', {
    method: 'POST',
    body: { documentIds: ids },
  });
}

export function listDocumentRecycleBin(page = 1, pageSize = 20): Promise<RecycleBinListResponse> {
  return apiRequest<RecycleBinListResponse>(withQuery('/documents/recycle-bin', { page, pageSize }));
}

export function deleteDocumentPermanently(id: string): Promise<void> {
  return apiRequest<void>(`/documents/recycle-bin/${id}`, {
    method: 'DELETE',
  });
}

export function emptyDocumentRecycleBin(): Promise<void> {
  return apiRequest<void>('/documents/recycle-bin/empty', {
    method: 'POST',
  });
}

export function globalSearch(query: string): Promise<GlobalSearchResponse> {
  return apiRequest<GlobalSearchResponse>(withQuery('/search', { q: query }));
}

export function searchKnowledgeBase(
  knowledgeBaseId: string,
  input: KnowledgeBaseSearchRequest,
): Promise<KnowledgeBaseSearchResponse> {
  return apiRequest<KnowledgeBaseSearchResponse>(`/knowledge-bases/${knowledgeBaseId}/search`, {
    method: 'POST',
    body: input,
  });
}

export function createChatSession(knowledgeBaseId: string, title: string): Promise<ChatSession> {
  return apiRequest<ChatSession>('/chat/sessions', {
    method: 'POST',
    body: { knowledgeBaseId, title },
  });
}

export function listChatSessions(): Promise<ChatSessionListResponse> {
  return apiRequest<ChatSessionListResponse>('/chat/sessions');
}

export function getChatSession(sessionId: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}`);
}

export function updateChatSessionTitle(sessionId: string, title: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}`, {
    method: 'PUT',
    body: { title },
  });
}

export function deleteChatSession(sessionId: string): Promise<void> {
  return apiRequest<void>(`/chat/sessions/${sessionId}`, {
    method: 'DELETE',
  });
}

export function archiveChatSession(sessionId: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}/archive`, {
    method: 'POST',
  });
}

export function listChatMessages(sessionId: string): Promise<ChatMessageListResponse> {
  return apiRequest<ChatMessageListResponse>(`/chat/sessions/${sessionId}/messages`);
}

export function sendChatMessage(
  sessionId: string,
  content: string,
): Promise<SendChatMessageResponse> {
  return apiRequest<SendChatMessageResponse>(`/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: { content },
  });
}

function withQuery(path: string, params: Record<string, unknown>): string {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '' || value === 'all') {
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 0) {
        query.set(key, value.join(','));
      }
      return;
    }
    query.set(key, String(value));
  });

  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}
