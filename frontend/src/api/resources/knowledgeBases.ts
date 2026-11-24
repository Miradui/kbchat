import { invalidateKnowledgeBaseOptionsAfter } from '../../store/queryClient';
import type {
  BatchResultResponse,
  KnowledgeBase,
  KnowledgeBaseBatchTagMode,
  KnowledgeBaseCategory,
  KnowledgeBaseCategoryInput,
  KnowledgeBaseCategoryListResponse,
  KnowledgeBaseCategoryReorderItem,
  KnowledgeBaseDetailStatsResponse,
  KnowledgeBaseInput,
  KnowledgeBaseListParams,
  KnowledgeBaseListResponse,
  KnowledgeBasePermissionResponse,
  KnowledgeBaseStatsResponse,
  KnowledgeBaseTag,
  KnowledgeBaseTagInput,
  KnowledgeBaseTagListResponse,
  KnowledgeBaseWorkspacePreference,
  MemberRole,
  RecycleBinListResponse,
} from '../../types/api';
import { apiRequest } from '../client';
import { withQuery } from './helpers';

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
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<void>(`/knowledge-bases/${id}/favorite`, {
    method: 'POST',
  }));
}

export function unfavoriteKnowledgeBase(id: string): Promise<void> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<void>(`/knowledge-bases/${id}/favorite`, {
    method: 'DELETE',
  }));
}

export function recordKnowledgeBaseView(id: string): Promise<void> {
  return apiRequest<void>(`/knowledge-bases/${id}/view`, {
    method: 'POST',
  });
}

export function batchFavoriteKnowledgeBases(ids: string[], favorite: boolean): Promise<BatchResultResponse> {
  return invalidateKnowledgeBaseOptionsAfter(apiRequest<BatchResultResponse>('/knowledge-bases/batch-favorite', {
    method: 'POST',
    body: { knowledgeBaseIds: ids, favorite },
  }));
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
