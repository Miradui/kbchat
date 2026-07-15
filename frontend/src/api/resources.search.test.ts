import { describe, expect, it, vi } from 'vitest';

import { apiRequest } from './client';
import { globalSearch } from './resources';

vi.mock('./client', () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn() }));

describe('search resources', () => {
  it('forwards the abort signal to the API client', () => {
    vi.mocked(apiRequest).mockResolvedValue({ items: [] });
    const controller = new AbortController();

    void globalSearch('leave policy', controller.signal);

    expect(apiRequest).toHaveBeenCalledWith('/search?q=leave+policy', {
      signal: controller.signal,
    });
  });
});
