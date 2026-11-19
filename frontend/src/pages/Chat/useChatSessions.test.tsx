import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { listChatSessions, listKnowledgeBases } from '../../api/resources';
import { tokenStore } from '../../store/tokenStore';
import type { ChatSession, ChatSessionListResponse } from '../../types/api';
import { useChatSessions } from './useChatSessions';
import { useSessionRailPreferences } from './useSessionRailPreferences';

vi.mock('../../api/resources', () => ({ listChatSessions: vi.fn(), listKnowledgeBases: vi.fn() }));
const session: ChatSession = {
  id: 's1', knowledgeBaseId: 'kb1', title: '制度问答', archivedAt: null,
  createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z', messageCount: 4,
};
const page = (items: ChatSession[], total = items.length, number = 1): ChatSessionListResponse => ({ items, total, page: number, pageSize: 50 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.mocked(listKnowledgeBases).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(listChatSessions).mockReset().mockResolvedValue(page([session]));
});

it('reuses loaded history pages immediately when a page remounts', async () => {
  const second = { ...session, id: 's2', title: '产品问答' };
  vi.mocked(listChatSessions).mockResolvedValueOnce(page([session], 2)).mockResolvedValueOnce(page([second], 2, 2));
  const first = renderHook(() => useChatSessions());
  await waitFor(() => expect(first.result.current.sessions).toHaveLength(1));
  await act(() => first.result.current.loadMoreSessions());
  await waitFor(() => expect(first.result.current.sessions).toHaveLength(2));
  first.unmount();
  const next = renderHook(() => useChatSessions());
  expect(next.result.current.sessions.map((item) => item.id)).toEqual(['s1', 's2']);
  expect(next.result.current.sessionsLoading).toBe(false);
  expect(next.result.current.hasMoreSessions).toBe(false);
  expect(listChatSessions).toHaveBeenCalledTimes(2);
});

it('keeps a rename and deletion when an older refresh finishes', async () => {
  const stale = deferred<ChatSessionListResponse>();
  const view = renderHook(() => useChatSessions());
  await waitFor(() => expect(view.result.current.sessions).toHaveLength(1));
  vi.mocked(listChatSessions).mockReturnValueOnce(stale.promise);
  act(() => { void view.result.current.reloadSessions(); });
  await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(2));
  const { messageCount: _count, ...detail } = session;
  act(() => view.result.current.mergeSession({ ...detail, title: '已更新标题' }));
  await waitFor(() => expect(view.result.current.sessions[0].title).toBe('已更新标题'));
  expect(view.result.current.sessions[0].messageCount).toBe(4);
  await act(async () => stale.resolve(page([session])));
  expect(view.result.current.sessions[0].title).toBe('已更新标题');
  act(() => view.result.current.removeSession(session.id));
  await waitFor(() => expect(view.result.current.sessions).toHaveLength(0));
  expect(view.result.current.sessionTotal).toBe(0);
});

it('removes inaccessible history from every previously loaded filter', async () => {
  const all = renderHook(() => useChatSessions());
  const filtered = renderHook(() => useChatSessions({ knowledgeBaseId: 'kb1' }));
  await waitFor(() => expect(filtered.result.current.sessions).toHaveLength(1));
  await waitFor(() => expect(all.result.current.sessions).toHaveLength(1));
  act(() => all.result.current.removeSession(session.id));
  await waitFor(() => expect(filtered.result.current.sessions).toHaveLength(0));
  expect(all.result.current.sessions).toHaveLength(0);
});

it('keeps the loaded rows when a background refresh fails', async () => {
  const view = renderHook(() => useChatSessions());
  await waitFor(() => expect(view.result.current.sessions).toHaveLength(1));
  vi.mocked(listChatSessions).mockRejectedValueOnce(new ApiError(503, { code: 'INTERNAL_ERROR', message: '服务暂时不可用', details: {} }));

  await act(async () => { await view.result.current.reloadSessions(); });

  // A refetch failure still sets isError while the previous data stays cached, so
  // reporting it as a load failure replaced a usable list with an error panel on
  // every network blip.
  expect(view.result.current.sessions).toHaveLength(1);
  expect(view.result.current.sessionsError).toBe('');
  await waitFor(() => expect(view.result.current.sessionsRefetchError).toBe('会话列表加载失败'));
});

it('clears history and rail preferences on account change and ignores old responses', async () => {
  tokenStore.setToken('first-account');
  const oldRefresh = deferred<ChatSessionListResponse>();
  const newList = deferred<ChatSessionListResponse>();
  const view = renderHook(() => ({ history: useChatSessions(), preferences: useSessionRailPreferences() }));
  await waitFor(() => expect(view.result.current.history.sessions).toHaveLength(1));
  act(() => view.result.current.preferences[1]({ scope: 'archived', knowledgeBaseId: 'kb1' }));
  vi.mocked(listChatSessions).mockReturnValueOnce(oldRefresh.promise).mockReturnValueOnce(newList.promise);
  act(() => { void view.result.current.history.reloadSessions(); });
  await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(2));
  act(() => tokenStore.setToken('second-account'));
  expect(view.result.current.history.sessions).toEqual([]);
  expect(view.result.current.preferences[0]).toEqual({ scope: 'active', knowledgeBaseId: '' });
  await act(async () => oldRefresh.resolve(page([session])));
  expect(view.result.current.history.sessions).toEqual([]);
  await act(async () => newList.resolve(page([{ ...session, id: 'new-account-session' }])));
  await waitFor(() => expect(view.result.current.history.sessions[0]?.id).toBe('new-account-session'));
});

it('retains rail preferences while reading longer than the data cache lifetime', () => {
  vi.useFakeTimers();
  try {
    const view = renderHook(() => useSessionRailPreferences());
    act(() => view.result.current[1]({ scope: 'archived', knowledgeBaseId: 'kb1' }));
    act(() => { vi.advanceTimersByTime(600_000); });
    expect(view.result.current[0]).toEqual({ scope: 'archived', knowledgeBaseId: 'kb1' });
    view.unmount();
    const next = renderHook(() => useSessionRailPreferences());
    expect(next.result.current[0]).toEqual({ scope: 'archived', knowledgeBaseId: 'kb1' });
  } finally {
    vi.useRealTimers();
  }
});
