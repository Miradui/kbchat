import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { listChatMessages } from '../../api/resources';
import type { ChatMessage, ChatMessageListResponse } from '../../types/api';
import { useChatHistory } from './useChatHistory';

vi.mock('../../api/resources', () => ({ listChatMessages: vi.fn() }));
const message = (id: string): ChatMessage => ({ id, sessionId: 's1', role: 'assistant', content: id, citations: [], createdAt: '2026-10-08T00:00:00Z' });
const latest = { items: [message('m3'), message('m4')], hasMore: true, nextCursor: 'c3', revision: 'm4' };
function setup() {
  const denied = vi.fn().mockReturnValue(false);
  const hook = renderHook(({ sessionId }) => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    return { messages, ...useChatHistory(sessionId, setMessages, denied) };
  }, { initialProps: { sessionId: 's1' } });
  act(() => hook.result.current.replaceHistory('s1', latest));
  return { ...hook, denied };
}
beforeEach(() => vi.mocked(listChatMessages).mockReset());

it('prepends complete pages once and refreshes only the loaded range', async () => {
  const { result } = setup();
  const anchor = vi.fn();
  vi.mocked(listChatMessages).mockResolvedValue({ items: [message('m1'), message('m2')], nextCursor: 'c1', revision: 'm4' });
  await act(async () => { await result.current.loadOlderMessages(anchor); });
  expect(result.current.messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  expect(anchor).toHaveBeenCalledOnce();
  expect(result.current.hasOlderMessages).toBe(false);
  expect(listChatMessages).toHaveBeenCalledWith('s1', { limit: 50, before: 'c3', revision: 'm4' }, expect.any(AbortSignal));
  await result.current.readCurrentHistory('s1');
  expect(listChatMessages).toHaveBeenLastCalledWith('s1', { limit: 50, since: 'c1' });
});

it.each(['switch', 'write'] as const)('discards delayed history after a %s', async (action) => {
  const { result, rerender } = setup();
  let resolve!: (value: ChatMessageListResponse) => void;
  vi.mocked(listChatMessages).mockReturnValue(new Promise((done) => { resolve = done; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadOlderMessages(); });
  if (action === 'switch') rerender({ sessionId: 's2' });
  else act(() => result.current.invalidateHistory());
  await act(async () => { resolve({ items: [message('late')] }); await pending; });
  expect(result.current.messages.map((item) => item.id)).toEqual(['m3', 'm4']);
  expect(result.current.loadingHistory).toBe(false);
});

it('keeps loaded messages on failure and supports a retry and explicit complete search', async () => {
  const { result } = setup();
  vi.mocked(listChatMessages).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await result.current.loadOlderMessages(); });
  expect(result.current.messages).toEqual(latest.items);
  expect(result.current.historyError).toBeTruthy();
  vi.mocked(listChatMessages).mockResolvedValue({ items: [message('m1'), ...latest.items] });
  await act(async () => { await result.current.loadAllMessages(); });
  expect(listChatMessages).toHaveBeenLastCalledWith('s1', undefined, expect.any(AbortSignal));
  expect(result.current.hasOlderMessages).toBe(false);
  expect(result.current.historyError).toBe('');
  await result.current.readCurrentHistory('s1');
  expect(listChatMessages).toHaveBeenLastCalledWith('s1');
});

it('reloads the latest page if another editor removed the loaded boundary', async () => {
  const { result } = setup();
  vi.mocked(listChatMessages).mockRejectedValueOnce(new ApiError(409, { code: 'CHAT_MESSAGE_CHANGED', message: 'changed' })).mockResolvedValueOnce(latest);
  expect(await result.current.readCurrentHistory('s1')).toEqual(latest);
  expect(listChatMessages).toHaveBeenLastCalledWith('s1', { limit: 50 });
});

it('forwards revoked access and invalidates pagination', async () => {
  const { result, denied } = setup();
  const error = new ApiError(404, { code: 'RESOURCE_NOT_FOUND', message: 'gone' });
  denied.mockReturnValue(true);
  vi.mocked(listChatMessages).mockRejectedValueOnce(error);
  await act(async () => { await result.current.loadOlderMessages(); });
  expect(denied).toHaveBeenCalledWith(error, 's1');
  expect(result.current.hasOlderMessages).toBe(false);
});

it('replaces a distant window, appends and prepends context without losing either cursor', async () => {
  const { result } = setup();
  vi.mocked(listChatMessages).mockResolvedValueOnce({ items: [message('m10'), message('m11')], hasMore: true, hasNewer: true, nextCursor: 'c10', newerCursor: 'c11', revision: 'last' });
  await act(async () => { await result.current.loadMessageContext('m10'); });
  expect(result.current.messages.map((item) => item.id)).toEqual(['m10', 'm11']);
  expect(result.current.hasNewerMessages).toBe(true);
  expect(listChatMessages).toHaveBeenLastCalledWith('s1', { limit: 50, around: 'm10' }, expect.any(AbortSignal));
  vi.mocked(listChatMessages).mockResolvedValueOnce({ items: [message('m12')], hasMore: true, hasNewer: true, nextCursor: 'c12', newerCursor: 'c12', revision: 'last' });
  await act(async () => { await result.current.loadNewerMessages(); });
  expect(listChatMessages).toHaveBeenLastCalledWith('s1', { limit: 50, after: 'c11', revision: 'last' }, expect.any(AbortSignal));
  vi.mocked(listChatMessages).mockResolvedValueOnce({ items: [message('m9')], hasNewer: true, nextCursor: 'c9', newerCursor: 'c9', revision: 'last' });
  await act(async () => { await result.current.loadOlderMessages(); });
  expect(listChatMessages).toHaveBeenLastCalledWith('s1', { limit: 50, before: 'c10', revision: 'last' }, expect.any(AbortSignal));
  expect(result.current.messages.map((item) => item.id)).toEqual(['m9', 'm10', 'm11', 'm12']);
  expect(result.current.hasOlderMessages).toBe(false);
  expect(result.current.hasNewerMessages).toBe(true);
  vi.mocked(listChatMessages).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await result.current.loadNewerMessages(); });
  vi.mocked(listChatMessages).mockResolvedValueOnce({ items: [message('m13')], newerCursor: 'c13', revision: 'last' });
  await act(async () => { await result.current.retryHistory(); });
  expect(listChatMessages).toHaveBeenLastCalledWith('s1', { limit: 50, after: 'c12', revision: 'last' }, expect.any(AbortSignal));
  expect(result.current.hasNewerMessages).toBe(false);
});

it('distinguishes a deleted search hit from revoked session access and lets the user return to latest', async () => {
  const { result, denied } = setup();
  vi.mocked(listChatMessages).mockRejectedValueOnce(new ApiError(404, { code: 'CHAT_MESSAGE_NOT_FOUND', message: 'gone' }));
  await act(async () => { await result.current.loadMessageContext('deleted'); });
  expect(result.current.missingMessageId).toBe('deleted');
  expect(result.current.messages).toEqual(latest.items);
  expect(denied).not.toHaveBeenCalled();
  let resolve!: (value: ChatMessageListResponse) => void;
  vi.mocked(listChatMessages).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadLatestMessages(); result.current.cancelMessageContext(); });
  expect(vi.mocked(listChatMessages).mock.calls.at(-1)?.[2]?.aborted).toBe(false);
  await act(async () => { resolve(latest); await pending; });
  expect(result.current.missingMessageId).toBe('');
});

it('discards a slower context request after a different hit is selected', async () => {
  const { result } = setup();
  let resolve!: (value: ChatMessageListResponse) => void;
  vi.mocked(listChatMessages).mockReturnValueOnce(new Promise((done) => { resolve = done; }))
    .mockResolvedValueOnce({ items: [message('new-target')], hasNewer: true, newerCursor: 'new' });
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadMessageContext('old-target'); });
  await act(async () => { await result.current.loadMessageContext('new-target'); });
  await act(async () => { resolve({ items: [message('stale')] }); await pending; });
  expect(result.current.messages.map((item) => item.id)).toEqual(['new-target']);
});
