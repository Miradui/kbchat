import { invalidateKnowledgeBaseOptionsAfter } from '../store/queryClient';
import { ApiError, apiBlobRequest, apiEventStream, apiRequest, apiUploadRequest } from './client';
import type {
  ActivityListResponse,
  AdminActivityListResponse,
  TransferOwnershipInput,
  TextDocumentInput,
  AdminUser,
  AdminUserCreateInput,
  AdminUserListResponse,
  BatchResultResponse,
  ChangePasswordInput,
  ChatFeedbackRating,
  ChatFeedbackDetails,
  ChatMessageFeedback,
  ChatKnowledgeGapListResponse,
  ChatKnowledgeGapParams,
  ChatMessageListResponse,
  ChatQualityFeedbackListResponse,
  ChatQualityFeedbackParams,
  ChatQualityOverview,
  ChatQualityOverviewParams,
  ChatUsageGroupBy,
  ChatUsageResponse,
  ChatSession,
  ChatSessionListParams,
  Citation,
  ChatSessionListResponse,
  DocumentChunkListResponse,
  DocumentChunkListParams,
  DocumentCountsParams,
  DocumentCountsResponse,
  DocumentItem,
  DocumentListResponse,
  DocumentPreviewResponse,
  DocumentUpdateInput,
  GlobalDocumentListParams,
  GlobalDocumentListResponse,
  GlobalSearchResponse,
  GlobalSearchParams,
  HomeSummaryResponse,
  KnowledgeBase,
  KnowledgeBaseCategory,
  KnowledgeBaseCategoryInput,
  KnowledgeBaseCategoryListResponse,
  KnowledgeBaseCategoryReorderItem,
  KnowledgeBaseBatchTagMode,
  KnowledgeBaseDetailStatsResponse,
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
  RegenerateChatMessageResponse,
  SendChatMessageResponse,
  SendChatMessageRequest,
  EditChatMessageRequest,
  SearchSuggestResponse,
  SystemCapabilities,
  SystemDiagnostics,
  UpdateProfileInput,
  User,
  UserSearchResponse,
} from '../types/api';

export function login(username: string, password: string): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { username, password },
    redirectOnUnauthorized: false,
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

export function updateProfile(input: UpdateProfileInput): Promise<User> {
  return apiRequest<User>('/auth/me', {
    method: 'PUT',
    body: { displayName: input.displayName, ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}) },
  });
}

export function uploadAvatar(file: File): Promise<User> {
  const body = new FormData();
  body.append('file', file);
  return apiUploadRequest<User>('/auth/me/avatar', body);
}

export function removeAvatar(): Promise<User> {
  return apiRequest<User>('/auth/me/avatar', { method: 'DELETE' });
}

export function changePassword(input: ChangePasswordInput): Promise<void> {
  return apiRequest<void>('/auth/change-password', {
    method: 'POST',
    body: input,
  });
}

/**
 * Server-side limits the UI used to hardcode: upload allow list and size cap,
 * retrieval ceilings, and whether rerank is enabled.
 */
export function getSystemCapabilities(): Promise<SystemCapabilities> {
  return apiRequest<SystemCapabilities>('/system/capabilities');
}

/** Everything the workspace landing page needs, in one request. */
export function getHomeSummary(period: 'day' | 'month' = 'month'): Promise<HomeSummaryResponse> {
  return apiRequest<HomeSummaryResponse>(withQuery('/home/summary', { period }));
}

/**
 * Recorded workspace events, newest first. Unlike a merge of the three lists,
 * this includes things that no longer exist: deletes, restores and membership
 * changes. See docs/04-api-design.md (GET /activities).
 */
export function listActivities(limit = 20): Promise<ActivityListResponse> {
  return apiRequest<ActivityListResponse>(withQuery('/activities', { limit }));
}

export function listKnowledgeBases(params: KnowledgeBaseListParams = {}, signal?: AbortSignal): Promise<KnowledgeBaseListResponse> {
  return apiRequest<KnowledgeBaseListResponse>(withQuery('/knowledge-bases', {
    ...params,
    scope: params.scope === 'all' ? undefined : params.scope,
    visibility: params.visibility === 'all' ? undefined : params.visibility,
  }), { signal });
}

export function getKnowledgeBase(id: string): Promise<KnowledgeBase> {
  return apiRequest<KnowledgeBase>(`/knowledge-bases/${id}`);
}

export function createKnowledgeBase(input: KnowledgeBaseInput): Promise<KnowledgeBase> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<KnowledgeBase>('/knowledge-bases', {
    method: 'POST',
    body: input,
  }));
}

export function updateKnowledgeBase(id: string, input: KnowledgeBaseInput): Promise<KnowledgeBase> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<KnowledgeBase>(`/knowledge-bases/${id}`, {
    method: 'PUT',
    body: input,
  }));
}

export function deleteKnowledgeBase(id: string): Promise<void> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<void>(`/knowledge-bases/${id}`, {
    method: 'DELETE',
  }));
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

/**
 * Trends for one knowledge base. Kept off `GET /knowledge-bases/:id` on purpose:
 * detail responses stay free of list-only aggregates.
 */
export function getKnowledgeBaseDetailStats(
  id: string,
  period: 'day' | 'month' = 'month',
): Promise<KnowledgeBaseDetailStatsResponse> {
  return apiRequest<KnowledgeBaseDetailStatsResponse>(
    withQuery(`/knowledge-bases/${id}/stats`, { period }),
  );
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
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<BatchResultResponse>('/knowledge-bases/batch-delete', {
    method: 'POST',
    body: { knowledgeBaseIds: ids },
  }));
}

export function restoreKnowledgeBase(id: string): Promise<void> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<void>(`/knowledge-bases/${id}/restore`, {
    method: 'POST',
  }));
}

export function batchRestoreKnowledgeBases(ids: string[]): Promise<BatchResultResponse> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<BatchResultResponse>('/knowledge-bases/batch-restore', {
    method: 'POST',
    body: { knowledgeBaseIds: ids },
  }));
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

/**
 * All-or-nothing, like the other batch endpoints: one unowned knowledge base or
 * tag rejects the whole call. `replace` with an empty `tagIds` clears every tag;
 * `add` and `remove` require at least one tag.
 */
export function batchTagKnowledgeBases(
  ids: string[],
  tagIds: string[],
  mode: KnowledgeBaseBatchTagMode = 'add',
): Promise<BatchResultResponse> {
  return apiRequest<BatchResultResponse>('/knowledge-bases/batch-tag', {
    method: 'POST',
    body: { knowledgeBaseIds: ids, tagIds, mode },
  });
}

export function listKnowledgeBaseRecycleBin(page = 1, pageSize = 20): Promise<RecycleBinListResponse> {
  return apiRequest<RecycleBinListResponse>(
    withQuery('/knowledge-bases/recycle-bin', { page, pageSize }),
  );
}

export function deleteKnowledgeBasePermanently(id: string): Promise<void> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<void>(`/knowledge-bases/recycle-bin/${id}`, {
    method: 'DELETE',
  }));
}

export function emptyKnowledgeBaseRecycleBin(): Promise<void> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<void>('/knowledge-bases/recycle-bin/empty', {
    method: 'POST',
  }));
}

export function getKnowledgeBasePermissions(id: string): Promise<KnowledgeBasePermissionResponse> {
  return apiRequest<KnowledgeBasePermissionResponse>(`/knowledge-bases/${id}/permissions`);
}

export function updateKnowledgeBasePermissions(
  id: string,
  visibility: 'private' | 'public',
): Promise<KnowledgeBasePermissionResponse> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<KnowledgeBasePermissionResponse>(`/knowledge-bases/${id}/permissions`, {
    method: 'PUT',
    body: { visibility },
  }));
}

export function searchUsers(q: string, limit = 20): Promise<UserSearchResponse> {
  return apiRequest<UserSearchResponse>(withQuery('/users/search', { q, limit }));
}

export function listAdminUsers(params: { q?: string; status?: string; role?: string; page?: number; pageSize?: number } = {}): Promise<AdminUserListResponse> {
  return apiRequest<AdminUserListResponse>(withQuery('/admin/users', params));
}

export function listAdminActivities(params: { page?: number; pageSize?: number } = {}): Promise<AdminActivityListResponse> {
  return apiRequest<AdminActivityListResponse>(withQuery('/admin/activities', params));
}

export function transferKnowledgeBaseOwnership(id: string, input: TransferOwnershipInput): Promise<{ transferredCount: number }> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<{ transferredCount: number }>(`/knowledge-bases/${id}/transfer-ownership`, { method: 'POST', body: input }));
}

export function transferUserKnowledgeBases(id: string, input: TransferOwnershipInput): Promise<{ transferredCount: number }> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<{ transferredCount: number }>(`/admin/users/${id}/transfer-knowledge-bases`, { method: 'POST', body: input }));
}

export function createAdminUser(input: AdminUserCreateInput): Promise<{ user: AdminUser; initialPassword: string }> {
  return apiRequest<{ user: AdminUser; initialPassword: string }>('/admin/users', { method: 'POST', body: input });
}

export function updateAdminUser(id: string, input: { displayName: string; status: string }): Promise<AdminUser> {
  return apiRequest<AdminUser>(`/admin/users/${id}`, { method: 'PUT', body: input });
}

export function resetAdminUserPassword(id: string): Promise<{ user: AdminUser; password: string }> {
  return apiRequest<{ user: AdminUser; password: string }>(`/admin/users/${id}/reset-password`, { method: 'POST' });
}

export function updateAdminUserRole(id: string, role: string): Promise<AdminUser> {
  return apiRequest<AdminUser>(`/admin/users/${id}/role`, { method: 'PUT', body: { role } });
}

export function addKnowledgeBaseMember(
  id: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<void>(`/knowledge-bases/${id}/members`, {
    method: 'POST',
    body: { userId, role },
  }));
}

export function updateKnowledgeBaseMember(
  id: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<void>(`/knowledge-bases/${id}/members/${userId}`, {
    method: 'PUT',
    body: { role },
  }));
}

export function deleteKnowledgeBaseMember(id: string, userId: string): Promise<void> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<void>(`/knowledge-bases/${id}/members/${userId}`, {
    method: 'DELETE',
  }));
}

/**
 * Knowledge-base-scoped document list. Same query surface as
 * {@link listGlobalDocuments}; knowledgeBaseId comes from the path.
 */
export function listDocuments(
  knowledgeBaseId: string,
  params: Omit<GlobalDocumentListParams, 'knowledgeBaseId'> = {},
): Promise<DocumentListResponse> {
  return apiRequest<DocumentListResponse>(
    withQuery(`/knowledge-bases/${knowledgeBaseId}/documents`, params),
  );
}

export function listGlobalDocuments(
  params: GlobalDocumentListParams = {},
  signal?: AbortSignal,
): Promise<GlobalDocumentListResponse> {
  return apiRequest<GlobalDocumentListResponse>(withQuery('/documents', params), { signal });
}

export function getDocumentCounts(params: DocumentCountsParams = {}, signal?: AbortSignal): Promise<DocumentCountsResponse> {
  return apiRequest<DocumentCountsResponse>(withQuery('/documents/counts', params), { signal });
}

export function getDocument(id: string, signal?: AbortSignal): Promise<DocumentItem> {
  return apiRequest<DocumentItem>(`/documents/${id}`, { signal });
}

export function createTextDocument(knowledgeBaseId: string, input: TextDocumentInput, signal?: AbortSignal): Promise<DocumentItem> {
  return apiRequest<DocumentItem>(`/knowledge-bases/${knowledgeBaseId}/documents/text`, { method: 'POST', body: input, signal });
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

/**
 * Carried in the multipart body rather than the query string because the file and
 * the decision about it belong to the same request — a query parameter would let
 * the two disagree. Omitting it means the default: a duplicate is rejected with a
 * 409 so the user can choose.
 */
export type UploadDocumentOptions = {
  allowDuplicate?: boolean;
};

export function uploadDocument(
  knowledgeBaseId: string,
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  options: UploadDocumentOptions = {},
): Promise<DocumentItem> {
  const body = new FormData();
  body.append('file', file);
  appendUploadOptions(body, options);

  return apiUploadRequest<DocumentItem>(`/knowledge-bases/${knowledgeBaseId}/documents`, body, {
    onProgress,
    signal,
  });
}

export function uploadGlobalDocument(
  knowledgeBaseId: string,
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  options: UploadDocumentOptions = {},
): Promise<DocumentItem> {
  const body = new FormData();
  body.append('knowledgeBaseId', knowledgeBaseId);
  body.append('file', file);
  appendUploadOptions(body, options);

  return apiUploadRequest<DocumentItem>('/documents', body, { onProgress, signal });
}

/**
 * The field is only sent when the override is on. The server reads anything other
 * than "true" as the default, so sending "false" would be equivalent, but omitting
 * it keeps a normal upload's body identical to what it was before this existed.
 */
function appendUploadOptions(body: FormData, options: UploadDocumentOptions): void {
  if (options.allowDuplicate) {
    body.append('allowDuplicate', 'true');
  }
}

/**
 * Replace a document with a new revision. The response is the *new* document: the
 * old one is kept and marked superseded rather than overwritten, so its chunks stay
 * answerable until the replacement finishes processing and the citation trail from
 * older answers does not break.
 *
 * Duplicate detection does not apply here — re-uploading the same content as a
 * deliberate replacement is not a conflict.
 */
export function replaceDocument(
  id: string,
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<DocumentItem> {
  const body = new FormData();
  body.append('file', file);

  return apiUploadRequest<DocumentItem>(`/documents/${id}/replace`, body, {
    onProgress,
    signal,
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

/**
 * Rename and/or move a document. A move carries the document's chunks with it,
 * and is rejected with `DOCUMENT_JOB_ACTIVE` while a job is queued or running.
 */
export function updateDocument(id: string, input: DocumentUpdateInput): Promise<DocumentItem> {
  return apiRequest<DocumentItem>(`/documents/${id}`, {
    method: 'PUT',
    body: input,
  });
}

/**
 * Cancel a queued or running processing job. Returns `DOCUMENT_JOB_NOT_CANCELLABLE`
 * when the document has no active job.
 */
export function cancelDocumentJob(id: string): Promise<DocumentItem> {
  return apiRequest<DocumentItem>(`/documents/${id}/cancel`, {
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

export function globalSearch(params: GlobalSearchParams, signal?: AbortSignal): Promise<GlobalSearchResponse> {
  return apiRequest<GlobalSearchResponse>(withQuery('/search', {
    q: params.query,
    type: params.type === 'all' ? undefined : params.type,
    page: params.page,
    pageSize: params.pageSize,
  }), { signal });
}

export function exportGlobalSearch(
  params: Pick<GlobalSearchParams, 'query' | 'type'>,
): Promise<Blob> {
  return apiBlobRequest(withQuery('/search/export', {
    q: params.query,
    type: params.type === 'all' ? undefined : params.type,
  }));
}

/**
 * Title-level results for the command palette. Searches knowledge base names and
 * filenames only — no chunk content, no snippets — which is what makes it
 * cheaper than a full `globalSearch` on every keystroke pause.
 */
export function searchSuggest(
  query: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<SearchSuggestResponse> {
  return apiRequest<SearchSuggestResponse>(withQuery('/search/suggest', { q: query, limit }), { signal });
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

export function createChatSession(knowledgeBaseId: string | string[] | undefined, title: string): Promise<ChatSession> {
  return apiRequest<ChatSession>('/chat/sessions', {
    method: 'POST',
    body: knowledgeBaseId === undefined ? { scopeMode: 'auto', title }
      : Array.isArray(knowledgeBaseId) ? { knowledgeBaseIds: knowledgeBaseId, title } : { knowledgeBaseId, title },
  });
}

export function listChatSessions(
  params: ChatSessionListParams = {},
): Promise<ChatSessionListResponse> {
  return apiRequest<ChatSessionListResponse>(withQuery('/chat/sessions', params));
}

export function getChatSession(sessionId: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}`);
}

export function exportChatSession(sessionId: string): Promise<Blob> {
  return apiBlobRequest(`/chat/sessions/${sessionId}/export`);
}

export function updateChatSessionTitle(sessionId: string, title: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}`, {
    method: 'PUT',
    body: { title },
  });
}

/** Soft delete: the session moves to the chat recycle bin and keeps its messages. */
export function deleteChatSession(sessionId: string): Promise<void> {
  return apiRequest<void>(`/chat/sessions/${sessionId}`, {
    method: 'DELETE',
  });
}

export function listChatSessionRecycleBin(page = 1, pageSize = 20): Promise<RecycleBinListResponse> {
  return apiRequest<RecycleBinListResponse>(
    withQuery('/chat/sessions/recycle-bin', { page, pageSize }),
  );
}

export function restoreChatSession(sessionId: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}/restore`, {
    method: 'POST',
  });
}

export function deleteChatSessionPermanently(sessionId: string): Promise<void> {
  return apiRequest<void>(`/chat/sessions/recycle-bin/${sessionId}`, {
    method: 'DELETE',
  });
}

export function emptyChatSessionRecycleBin(): Promise<void> {
  return apiRequest<void>('/chat/sessions/recycle-bin/empty', {
    method: 'POST',
  });
}

export function archiveChatSession(sessionId: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}/archive`, {
    method: 'POST',
  });
}

export function unarchiveChatSession(sessionId: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}/unarchive`, {
    method: 'POST',
  });
}

export function listChatMessages(sessionId: string, params?: import('../types/api').ChatMessagePageParams, signal?: AbortSignal): Promise<ChatMessageListResponse> {
  return apiRequest<ChatMessageListResponse>(withQuery(`/chat/sessions/${sessionId}/messages`, params ?? {}), { signal });
}

export function setChatMessageFeedback(
  messageId: string,
  rating: ChatFeedbackRating,
  details?: ChatFeedbackDetails,
): Promise<ChatMessageFeedback> {
  return apiRequest<ChatMessageFeedback>(`/chat/messages/${messageId}/feedback`, {
    method: 'POST',
    body: { rating, ...details },
  });
}

export function getChatQualityOverview(
  params: ChatQualityOverviewParams = {},
): Promise<ChatQualityOverview> {
  return apiRequest<ChatQualityOverview>(withQuery('/chat/quality/overview', params));
}

export type ChatUsageParams = { knowledgeBaseId?: string; from?: string; to?: string; groupBy?: ChatUsageGroupBy };

export function getChatUsage(params: ChatUsageParams = {}): Promise<ChatUsageResponse> {
  return apiRequest<ChatUsageResponse>(withQuery('/chat/quality/usage', params));
}

export function listNegativeChatFeedback(
  params: ChatQualityFeedbackParams = {},
): Promise<ChatQualityFeedbackListResponse> {
  return apiRequest<ChatQualityFeedbackListResponse>(withQuery('/chat/quality/negative-feedback', params));
}

/**
 * Questions the knowledge base answered poorly. `category` defaults to both
 * categories concatenated, with `no_citations` first.
 */
export function listChatKnowledgeGaps(
  params: ChatKnowledgeGapParams = {},
): Promise<ChatKnowledgeGapListResponse> {
  return apiRequest<ChatKnowledgeGapListResponse>(withQuery('/chat/quality/knowledge-gaps', {
    ...params, category: params.category === 'all' ? undefined : params.category,
  }));
}

export function sendChatMessage(
  sessionId: string,
  input: SendChatMessageRequest,
): Promise<SendChatMessageResponse> {
  return apiRequest<SendChatMessageResponse>(`/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: input,
  });
}

export type ChatStreamHandlers = {
  onCitations?: (citations: Citation[]) => void;
  onDelta?: (text: string) => void;
};

/**
 * Streaming send. Same idempotency contract as `sendChatMessage`: the caller
 * still mints and persists the `clientRequestId`, and a resend reuses it.
 *
 * Resolves with the same payload the blocking endpoint returns. Rejects with an
 * `ApiError` for both pre-stream failures (401/404/409 …) and mid-stream `error`
 * events, so callers cannot tell the two apart by accident — which is correct,
 * because both mean "this attempt did not complete".
 *
 * **A rejection never means the write definitely failed.** Nothing is persisted
 * until generation finishes, but a connection that drops after the server
 * committed still rejects here, so callers must reconcile by `clientRequestId`
 * rather than assume. See docs/04-api-design.md (POST /chat/sessions/:id/messages/stream).
 */
export async function sendChatMessageStream(
  sessionId: string,
  input: SendChatMessageRequest,
  handlers: ChatStreamHandlers = {},
  signal?: AbortSignal,
): Promise<SendChatMessageResponse> {
  const stream = apiEventStream(`/chat/sessions/${sessionId}/messages/stream`, {
    method: 'POST',
    body: input,
    signal,
  });

  let done: SendChatMessageResponse | null = null;

  for await (const event of stream) {
    if (event.event === 'delta') {
      const payload = parseStreamPayload<{ text?: string }>(event.data);
      if (payload?.text) handlers.onDelta?.(payload.text);
    } else if (event.event === 'citations') {
      const payload = parseStreamPayload<{ citations?: Citation[] }>(event.data);
      handlers.onCitations?.(payload?.citations ?? []);
    } else if (event.event === 'done') {
      const payload = parseStreamPayload<unknown>(event.data);
      done = isCompletedChatResponse(payload, sessionId, input.clientRequestId) ? payload : null;
      break;
    } else if (event.event === 'error') {
      const payload = parseStreamPayload<{ status?: number; code?: string; message?: string; details?: Record<string, unknown> }>(event.data);
      throw new ApiError(payload?.status ?? 500, {
        code: payload?.code ?? 'INTERNAL_ERROR',
        message: payload?.message ?? '回答生成失败，请稍后重试。',
        details: payload?.details,
      });
    }
  }

  if (!done) {
    // The stream ended without `done`: the answer was not committed, and the
    // caller has to reconcile rather than treat this as a clean failure.
    throw new ApiError(0, { code: 'STREAM_INCOMPLETE', message: '回答尚未完成，连接已中断。' });
  }
  return done;
}

export function editChatMessage(
  sessionId: string,
  messageId: string,
  input: EditChatMessageRequest,
): Promise<SendChatMessageResponse> {
  return apiRequest<SendChatMessageResponse>(`/chat/sessions/${sessionId}/messages/${messageId}/edit`, {
    method: 'PUT',
    body: input,
  });
}

function isCompletedChatResponse(
  value: unknown,
  sessionId: string,
  clientRequestId: string,
): value is SendChatMessageResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<SendChatMessageResponse>;
  if (
    response.clientRequestId !== clientRequestId
    || typeof response.answer !== 'string'
    || !Array.isArray(response.citations)
    || !response.userMessage
    || !response.assistantMessage
  ) return false;
  return response.userMessage.sessionId === sessionId
    && response.userMessage.role === 'user'
    && response.userMessage.clientRequestId === clientRequestId
    && response.assistantMessage.sessionId === sessionId
    && response.assistantMessage.role === 'assistant'
    && response.assistantMessage.clientRequestId === clientRequestId;
}

function parseStreamPayload<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function regenerateChatMessage(
  sessionId: string,
  messageId: string,
): Promise<RegenerateChatMessageResponse> {
  return apiRequest<RegenerateChatMessageResponse>(
    `/chat/sessions/${sessionId}/messages/${messageId}/regenerate`,
    { method: 'POST' },
  );
}

function withQuery(path: string, params: Record<string, unknown>): string {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
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

/**
 * Deployment health. Always resolves for a reachable server: a failing
 * dependency comes back as `status: 'down'` in the payload, not as an HTTP error.
 */
export function getSystemDiagnostics(): Promise<SystemDiagnostics> {
  return apiRequest<SystemDiagnostics>('/system/diagnostics');
}

export { listEvaluationCases, saveEvaluationCase, deleteEvaluationCase, listEvaluationRuns, createEvaluationRun, getEvaluationRun, cancelEvaluationRun } from './evaluations';
