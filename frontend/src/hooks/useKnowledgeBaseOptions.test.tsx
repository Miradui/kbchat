import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { listKnowledgeBases } from '../api/resources';
import { tokenStore } from '../store/tokenStore';
import { invalidateKnowledgeBaseOptionsAfter, queryClient } from '../store/queryClient';
import { useKnowledgeBaseOptions, loadKnowledgeBaseOptions } from './useKnowledgeBaseOptions';
import type { KnowledgeBase, KnowledgeBaseListResponse } from '../types/api';

vi.mock('../api/resources', () => ({ listKnowledgeBases: vi.fn() }));
const kb: KnowledgeBase = {
  id: 'kb1',
  name: '资料',
  description: '',
  createdAt: '',
  updatedAt: '',
  retrievalConfig: {
    vectorTopN: 30,
    rerankTopK: 5,
    scoreThreshold: 0.3,
    enableRerank: true,
    enableKeyword: true,
  },
  answerConfig: {
    systemPromptAddition: '',
    answerLanguage: 'auto',
    model: '',
    allowGeneralKnowledge: false,
  },
};
beforeEach(() => {
  queryClient.clear();
  vi.mocked(listKnowledgeBases)
    .mockReset()
    .mockResolvedValue({ items: [kb] });
});

it('deduplicates subscribers, reuses fresh data and invalidates after a mutation', async () => {
  const first = renderHook(() => useKnowledgeBaseOptions());
  const second = renderHook(() => useKnowledgeBaseOptions());
  await waitFor(() => expect(first.result.current.items).toHaveLength(1));
  expect(listKnowledgeBases).toHaveBeenCalledTimes(1);
  first.unmount();
  second.unmount();
  const next = renderHook(() => useKnowledgeBaseOptions());
  expect(next.result.current.items[0].name).toBe('资料');
  expect(listKnowledgeBases).toHaveBeenCalledTimes(1);
  vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [{ ...kb, name: '新名称' }] });
  await act(async () => {
    await invalidateKnowledgeBaseOptionsAfter(Promise.resolve());
  });
  await waitFor(() => expect(next.result.current.items[0].name).toBe('新名称'));
  expect(listKnowledgeBases).toHaveBeenCalledTimes(2);
});

it('does not expose a prior account response even when cancellation is ignored', async () => {
  let resolveOld!: (value: KnowledgeBaseListResponse) => void;
  vi.mocked(listKnowledgeBases).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const view = renderHook(() => useKnowledgeBaseOptions());
  await waitFor(() => expect(listKnowledgeBases).toHaveBeenCalledTimes(1));
  const oldSignal = vi.mocked(listKnowledgeBases).mock.calls[0][1];
  vi.mocked(listKnowledgeBases).mockResolvedValue({
    items: [{ ...kb, id: 'new', name: '新账号资料' }],
  });
  act(() => tokenStore.setToken('new-account'));
  await waitFor(() => expect(view.result.current.items[0]?.id).toBe('new'));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => resolveOld({ items: [kb] }));
  expect(view.result.current.items[0]?.id).toBe('new');
  act(() => {
    window.localStorage.removeItem('rag.auth.token');
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'rag.auth.token', storageArea: window.localStorage }),
    );
  });
  expect(view.result.current.items).toEqual([]);
});

it.each([401, 403, 429])('does not retry HTTP %s', async (status) => {
  vi.mocked(listKnowledgeBases).mockRejectedValue(
    new ApiError(status, { code: 'DENIED', message: '拒绝' }),
  );
  const view = renderHook(() => useKnowledgeBaseOptions());
  await waitFor(() => expect(view.result.current.error).not.toBe(''));
  expect(listKnowledgeBases).toHaveBeenCalledTimes(1);
});

it('discards cached options on a denied refresh and recovers on explicit retry', async () => {
  const view = renderHook(() => useKnowledgeBaseOptions());
  await waitFor(() => expect(view.result.current.items).toHaveLength(1));
  vi.mocked(listKnowledgeBases).mockRejectedValue(
    new ApiError(403, { code: 'DENIED', message: '权限已失效' }),
  );
  await act(async () => {
    await view.result.current.reload();
  });
  await waitFor(() => expect(view.result.current.error).toBe('权限已失效'));
  expect(view.result.current.items).toEqual([]);
  expect(queryClient.getQueryCache().getAll()[0].state.data).toEqual([]);
  expect(listKnowledgeBases).toHaveBeenCalledTimes(2);
  vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [kb] });
  await act(async () => {
    await view.result.current.reload();
  });
  await waitFor(() => expect(view.result.current.items).toHaveLength(1));
  expect(view.result.current.error).toBe('');
});

it.each([new Error('离线'), new ApiError(503, { code: 'UNAVAILABLE', message: '暂不可用' })])(
  'retries a transient read once',
  async (error) => {
    vi.mocked(listKnowledgeBases).mockRejectedValueOnce(error);
    const view = renderHook(() => useKnowledgeBaseOptions());
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    expect(listKnowledgeBases).toHaveBeenCalledTimes(2);
  },
);

it('paginates past 100 knowledge bases and deduplicates by id', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    ...kb,
    id: `kb-${index + 1}`,
    name: `资料 ${index + 1}`,
  }));
  const secondPage = [
    firstPage[0],
    { ...kb, id: 'kb-101', name: '第 101 个资料' },
  ];
  vi.mocked(listKnowledgeBases)
    .mockResolvedValueOnce({ items: firstPage, total: 101, page: 1, pageSize: 100 })
    .mockResolvedValueOnce({ items: secondPage, total: 101, page: 2, pageSize: 100 });

  const view = renderHook(() => useKnowledgeBaseOptions());
  await waitFor(() => expect(view.result.current.items).toHaveLength(101));
  expect(view.result.current.items[100].id).toBe('kb-101');
  expect(listKnowledgeBases).toHaveBeenCalledTimes(2);
  expect(listKnowledgeBases).toHaveBeenNthCalledWith(1, { page: 1, pageSize: 100, sort: 'updatedAt_desc' }, expect.any(AbortSignal));
  expect(listKnowledgeBases).toHaveBeenNthCalledWith(2, { page: 2, pageSize: 100, sort: 'updatedAt_desc' }, expect.any(AbortSignal));
});

it('stops paginating when aborted before the next page', async () => {
  const controller = new AbortController();
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    ...kb,
    id: `kb-${index + 1}`,
    name: `资料 ${index + 1}`,
  }));
  vi.mocked(listKnowledgeBases).mockImplementationOnce(async () => {
    controller.abort();
    return { items: firstPage, total: 150, page: 1, pageSize: 100 };
  });

  await expect(loadKnowledgeBaseOptions(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(listKnowledgeBases).toHaveBeenCalledTimes(1);
});
