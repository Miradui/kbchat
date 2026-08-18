import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useKnowledgeBaseList } from './useKnowledgeBaseList';

const resourceMocks = vi.hoisted(() => ({
  listKnowledgeBases: vi.fn(),
  updateWorkspacePreference: vi.fn(),
}));

vi.mock('../../api/resources', () => resourceMocks);

function wrapper(initialEntry: string) {
  return function RouterWrapper({ children }: PropsWithChildren) {
    return <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>;
  };
}

describe('useKnowledgeBaseList paging', () => {
  beforeEach(() => {
    resourceMocks.listKnowledgeBases.mockReset();
    resourceMocks.updateWorkspacePreference.mockReset();
    resourceMocks.listKnowledgeBases.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it.each(['/knowledge-bases', '/knowledge-bases?pageSize=1', '/knowledge-bases?pageSize=invalid'])(
    'uses the supported default page size for %s',
    async (initialEntry) => {
      const { result } = renderHook(() => useKnowledgeBaseList(), {
        wrapper: wrapper(initialEntry),
      });

      await waitFor(() => expect(resourceMocks.listKnowledgeBases).toHaveBeenCalled());

      expect(result.current.filters.pageSize).toBe(20);
      expect(resourceMocks.listKnowledgeBases).toHaveBeenLastCalledWith(expect.objectContaining({
        page: 1,
        pageSize: 20,
      }));
    },
  );
});
