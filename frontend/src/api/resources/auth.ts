import { apiRequest, apiUploadRequest } from '../client';
import type {
  ActivityListResponse,
  ChangePasswordInput,
  HomeSummaryResponse,
  LoginResponse,
  SystemCapabilities,
  UpdateProfileInput,
  User,
} from '../../types/api';
import { withQuery } from './helpers';

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
