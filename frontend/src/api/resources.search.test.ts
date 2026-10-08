import { describe, expect, it, vi } from 'vitest';

import { apiRequest } from './client';
import { getDocumentCounts, globalSearch, listKnowledgeBases, listAdminUsers, listGlobalDocuments } from './resources';

vi.mock('./client', () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn() }));

describe('search resources', () => {
  it('requests document counts with scope, literal search and cancellation', () => {
    const controller = new AbortController();
    void getDocumentCounts({ q: 'all', knowledgeBaseId: 'kb1', fileType: 'pdf' }, controller.signal);
    expect(apiRequest).toHaveBeenCalledWith('/documents/counts?q=all&knowledgeBaseId=kb1&fileType=pdf', { signal: controller.signal });
  });
  it('preserves a literal all search while omitting only all-valued enum filters', () => {
    void globalSearch({ query: 'all', type: 'all' });
    void listKnowledgeBases({ q: 'all', scope: 'all', visibility: 'all' });
    void listAdminUsers({ q: 'all' });
    void listGlobalDocuments({ q: 'all' });
    const paths = vi.mocked(apiRequest).mock.calls.map(([path]) => path);
    expect(paths).toEqual(expect.arrayContaining(['/search?q=all', '/knowledge-bases?q=all', '/admin/users?q=all', '/documents?q=all']));
  });
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
