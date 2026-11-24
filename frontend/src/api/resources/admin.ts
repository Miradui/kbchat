import { invalidateKnowledgeBaseOptionsAfter } from '../../store/queryClient';
import type {
  AdminActivityListResponse,
  AdminUser,
  AdminUserCreateInput,
  AdminUserListResponse,
  TransferOwnershipInput,
  UserSearchResponse,
} from '../../types/api';
import { apiRequest } from '../client';
import { withQuery } from './helpers';

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
