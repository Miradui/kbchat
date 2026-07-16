import { describe, expect, it } from 'vitest';

import { tokenStore } from './tokenStore';

describe('tokenStore', () => {
  it('stores and clears the authentication token', () => {
    tokenStore.setToken('token-value');
    expect(tokenStore.getToken()).toBe('token-value');

    tokenStore.clearToken();
    expect(tokenStore.getToken()).toBeNull();
  });
});
