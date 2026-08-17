import { afterEach, describe, expect, it, vi } from 'vitest';

import { tokenStore } from '../store/tokenStore';
import { ApiError, apiRequest, apiUploadRequest } from './client';

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];

  method = '';
  url = '';
  requestHeaders: Record<string, string> = {};
  response: unknown = null;
  responseText = '';
  responseType = '';
  status = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }

  send() {}

  abort() {
    this.onabort?.();
  }
}

function unauthorizedResponse() {
  return new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS', message: '用户名或密码错误', details: {} }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  FakeXMLHttpRequest.instances = [];
  tokenStore.clearToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('apiUploadRequest', () => {
  it('reports upload progress and resolves the JSON response with auth', async () => {
    tokenStore.setToken('upload-token');
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    const onProgress = vi.fn();
    const request = apiUploadRequest<{ id: string }>('/documents', new FormData(), { onProgress });
    const xhr = FakeXMLHttpRequest.instances[0];

    expect(xhr.method).toBe('POST');
    expect(xhr.url).toContain('/api/v1/documents');
    expect(xhr.requestHeaders.Authorization).toBe('Bearer upload-token');
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 37, total: 100 } as ProgressEvent);
    xhr.status = 201;
    xhr.response = { id: 'document-1' };
    xhr.onload?.();

    await expect(request).resolves.toEqual({ id: 'document-1' });
    expect(onProgress).toHaveBeenNthCalledWith(1, 37);
    expect(onProgress).toHaveBeenLastCalledWith(100);
  });

  it('does not clear a newer login when an older upload returns 401', async () => {
    const onUnauthorized = vi.fn();
    tokenStore.setToken('old-token');
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    const request = apiUploadRequest('/documents', new FormData(), { onUnauthorized });
    const xhr = FakeXMLHttpRequest.instances[0];

    tokenStore.setToken('new-token');
    xhr.status = 401;
    xhr.response = { code: 'UNAUTHORIZED', message: '登录已过期', details: {} };
    xhr.onload?.();

    await expect(request).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(tokenStore.getToken()).toBe('new-token');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
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
