import { describe, expect, it, vi } from 'vitest';

import { apiRequest } from './client';
import { globalSearch } from './resources';

vi.mock('./client', () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn() }));

describe('search resources', () => {
  it('forwards the abort signal to the API client', () => {
	vi.mocked(apiRequest).mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 40 });
    const controller = new AbortController();

	void globalSearch({
		query: 'leave policy',
		type: 'document',
		page: 2,
		pageSize: 40,
	}, controller.signal);

	expect(apiRequest).toHaveBeenCalledWith('/search?q=leave+policy&type=document&page=2&pageSize=40', {
      signal: controller.signal,
    });
  });
});
