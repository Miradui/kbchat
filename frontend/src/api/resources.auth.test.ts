import { describe, expect, it, vi } from 'vitest';

import { apiRequest, apiUploadRequest } from './client';
import { login, removeAvatar, updateProfile, uploadAvatar } from './resources';

vi.mock('./client', () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn(), apiUploadRequest: vi.fn() }));

describe('auth resources', () => {
  it('suppresses the global unauthorized redirect for login', () => {
    vi.mocked(apiRequest).mockResolvedValue({ token: 'token', user: {} });
    void login('admin', 'bad');

    expect(apiRequest).toHaveBeenCalledWith('/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'bad' },
      redirectOnUnauthorized: false,
    });
  });

  it('distinguishes an omitted avatar from explicitly clearing it', () => {
    void updateProfile({ displayName: 'Owner' });
    expect(apiRequest).toHaveBeenLastCalledWith('/auth/me', { method: 'PUT', body: { displayName: 'Owner' } });
    void updateProfile({ displayName: 'Owner', avatarUrl: '' });
    expect(apiRequest).toHaveBeenLastCalledWith('/auth/me', { method: 'PUT', body: { displayName: 'Owner', avatarUrl: '' } });
  });

  it('uploads a multipart file and removes only the current user avatar', () => {
    const file = new File(['png'], 'avatar.png', { type: 'image/png' });
    void uploadAvatar(file);
    expect(apiUploadRequest).toHaveBeenLastCalledWith('/auth/me/avatar', expect.any(FormData));
    expect(vi.mocked(apiUploadRequest).mock.calls.at(-1)?.[1].get('file')).toBe(file);
    void removeAvatar();
    expect(apiRequest).toHaveBeenLastCalledWith('/auth/me/avatar', { method: 'DELETE' });
  });
});
