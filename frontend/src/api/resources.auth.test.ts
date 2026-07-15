import { describe, expect, it, vi } from 'vitest';

import { apiRequest } from './client';
import { login } from './resources';

vi.mock('./client', () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn() }));

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
});
