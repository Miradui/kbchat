import { afterEach, describe, expect, it, vi } from 'vitest';

import { tokenStore } from '../store/tokenStore';
import { ApiError, apiRequest } from './client';

function unauthorizedResponse() {
  return new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS', message: '用户名或密码错误', details: {} }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  tokenStore.clearToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('apiRequest unauthorized handling', () => {
  it('throws the login ApiError without redirecting or clearing local auth', async () => {
    const onUnauthorized = vi.fn();
    tokenStore.setToken('existing-token');
    const fetchMock = vi.fn().mockResolvedValue(unauthorizedResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/auth/login', {
      method: 'POST',
      redirectOnUnauthorized: false,
      onUnauthorized,
    })).rejects.toMatchObject({ status: 401, message: '用户名或密码错误' });

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(tokenStore.getToken()).toBe('existing-token');
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('redirectOnUnauthorized');
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('onUnauthorized');
  });

  it('clears auth and runs the unauthorized action for protected requests', async () => {
    const onUnauthorized = vi.fn();
    tokenStore.setToken('expired-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorizedResponse()));

    await expect(apiRequest('/knowledge-bases', { onUnauthorized })).rejects.toBeInstanceOf(ApiError);
    expect(tokenStore.getToken()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('handles concurrent unauthorized responses only once', async () => {
    const onUnauthorized = vi.fn();
    const clearToken = vi.spyOn(tokenStore, 'clearToken');
    tokenStore.setToken('expired-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorizedResponse()));

    const results = await Promise.allSettled([
      apiRequest('/knowledge-bases', { onUnauthorized }),
      apiRequest('/documents', { onUnauthorized }),
    ]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(clearToken).toHaveBeenCalledOnce();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
