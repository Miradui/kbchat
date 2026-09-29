import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import type { ChatMessage, ChatSession, SendChatMessageResponse } from '../../types/api';
import { pendingChatRequestStore } from './pendingChatRequestStore';
import { useChatThread } from './useChatThread';

const resourceMocks = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  editChatMessage: vi.fn(),
  getChatSession: vi.fn(),
  listChatMessages: vi.fn(),
  regenerateChatMessage: vi.fn(),
  sendChatMessageStream: vi.fn(),
}));

vi.mock('../../api/resources', () => resourceMocks);

const session: ChatSession = {
  id: 'session-1',
  knowledgeBaseId: 'kb-1',
  title: '测试会话',
  createdAt: '2026-08-10T00:00:00Z',
  updatedAt: '2026-08-10T00:00:00Z',
  archivedAt: null,
};

const completedResponse: SendChatMessageResponse = {
  clientRequestId: 'req-completed',
  userMessage: messagesForResponse('req-completed')[0],
  assistantMessage: messagesForResponse('req-completed')[1],
  answer: '完整回答',
  citations: [],
  rerankFallback: null,
};

function messagesForResponse(clientRequestId: string): [ChatMessage, ChatMessage] {
  return [
    {
      id: 'completed-user', sessionId: session.id, clientRequestId, role: 'user',
      content: '问题', citations: [], createdAt: '2026-08-10T00:00:01Z',
    },
    {
      id: 'completed-assistant', sessionId: session.id, clientRequestId, role: 'assistant',
      content: '完整回答', citations: [], createdAt: '2026-08-10T00:00:02Z',
    },
  ];
}

function messagesFor(clientRequestId: string): ChatMessage[] {
  return [
    {
      id: 'user-message-1',
      sessionId: session.id,
      clientRequestId,
      role: 'user',
      content: '问题',
      citations: [],
      createdAt: '2026-08-10T00:00:01Z',
    },
    {
      id: 'assistant-message-1',
      sessionId: session.id,
      clientRequestId,
      role: 'assistant',
      content: '服务端已经保存的回答',
      citations: [],
      createdAt: '2026-08-10T00:00:02Z',
    },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderThread() {
  const onSessionCreated = vi.fn();
  const onSessionsChanged = vi.fn();
  const onAccessLost = vi.fn();
  const hook = renderHook(() => useChatThread({
    sessionId: session.id,
    onSessionCreated,
    onSessionsChanged,
    onAccessLost,
  }));
  return { ...hook, onSessionCreated, onSessionsChanged, onAccessLost };
}

function renderThreadWithChangingSessionsCallback() {
  const onSessionCreated = vi.fn();
  const onSessionsChanged = vi.fn();
  const hook = renderHook(() => useChatThread({
    sessionId: session.id,
    onSessionCreated,
    onSessionsChanged: () => onSessionsChanged(),
  }));
  return { ...hook, onSessionCreated, onSessionsChanged };
}

describe('useChatThread send reconciliation', () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    resourceMocks.getChatSession.mockResolvedValue(session);
    resourceMocks.listChatMessages.mockResolvedValue({ items: [] });
    resourceMocks.createChatSession.mockResolvedValue(session);
    resourceMocks.regenerateChatMessage.mockResolvedValue({
      message: messagesFor('regenerate')[1],
      rerankFallback: null,
    });
    resourceMocks.editChatMessage.mockReset();
  });

  it.each(['send', 'edit', 'regenerate'] as const)('clears an inaccessible thread after %s instead of offering retries', async (operation) => {
    const original = messagesFor('old');
    resourceMocks.listChatMessages.mockResolvedValue({ items: original });
    const denied = new ApiError(404, { code: 'NOT_FOUND', message: 'resource not found' });
    resourceMocks.sendChatMessageStream.mockRejectedValue(denied);
    resourceMocks.editChatMessage.mockRejectedValue(denied);
    resourceMocks.regenerateChatMessage.mockRejectedValue(denied);
    const { result, onAccessLost } = renderThread();
    await settleEffects();
    await act(async () => {
      if (operation === 'send') await result.current.send('新问题');
      else if (operation === 'edit') await result.current.editMessage(original[0].id, '修改的问题');
      else await result.current.regenerate(original[1].id);
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.session).toBeNull();
    expect(result.current.failedSend).toBeNull();
    expect(result.current.unconfirmedSend).toBeNull();
    expect(result.current.regeneration).toBeNull();
    expect(result.current.sending).toBe(false);
    expect(result.current.loadError).toContain('会话已不可访问');
    expect(onAccessLost).toHaveBeenCalledWith(session.id);
    expect(pendingChatRequestStore.get(session.id)).toBeNull();
  });

  it('replaces the edited user turn and all later messages with the returned pair', async () => {
    const initial = [
      ...messagesFor('old-request'),
      { ...messagesFor('later-request')[0], id: 'later-user', content: '后续问题' },
      { ...messagesFor('later-request')[1], id: 'later-assistant', content: '后续回答' },
    ];
    resourceMocks.listChatMessages.mockResolvedValue({ items: initial });
    const editedUser = { ...initial[0], content: '修改后的问题', clientRequestId: 'edit-request' };
    const editedAssistant = { ...initial[1], id: 'edited-assistant', content: '修改后的回答', clientRequestId: 'edit-request' };
    resourceMocks.editChatMessage.mockResolvedValue({
      clientRequestId: 'edit-request',
      userMessage: editedUser,
      assistantMessage: editedAssistant,
      answer: editedAssistant.content,
      citations: [],
      rerankFallback: null,
    });
    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.editMessage(initial[0].id, '修改后的问题');
    });

    expect(resourceMocks.editChatMessage).toHaveBeenCalledWith(
      session.id,
      initial[0].id,
      expect.objectContaining({ content: '修改后的问题' }),
    );
    expect(result.current.messages).toEqual([editedUser, editedAssistant]);
    expect(result.current.editingId).toBeNull();
  });

  it('adopts a committed edit when the edit response is lost', async () => {
    const initial = messagesFor('old-request');
    const committed = [
      { ...initial[0], content: '修改后的问题', clientRequestId: 'lost-edit-request' },
      { ...initial[1], id: 'edited-assistant', content: '服务端已提交的新回答', clientRequestId: 'lost-edit-request' },
    ];
    resourceMocks.listChatMessages
      .mockResolvedValueOnce({ items: initial })
      .mockImplementationOnce(async () => {
        const request = resourceMocks.editChatMessage.mock.calls[0]?.[2] as { clientRequestId: string };
        return {
          items: committed.map((message) => ({ ...message, clientRequestId: request.clientRequestId })),
        };
      });
    resourceMocks.editChatMessage.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.editMessage(initial[0].id, '修改后的问题');
    });

    expect(result.current.messages[0].content).toBe('修改后的问题');
    expect(result.current.messages[1].content).toBe('服务端已提交的新回答');
    expect(window.localStorage.getItem(`rag.chat.pending-edit:${session.id}`)).toBeNull();
  });

  it('treats a partial stream without done as an unknown result', async () => {
    resourceMocks.sendChatMessageStream.mockImplementation(async (
      _sessionId: string,
      _input: unknown,
      handlers: { onDelta?: (text: string) => void },
    ) => {
      handlers.onDelta?.('半截回答');
      throw new ApiError(0, { code: 'STREAM_INCOMPLETE', message: '连接已中断' });
    });

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.send('问题');
    });

    expect(result.current.streamText.getSnapshot()).toBe('');
    expect(result.current.failedSend).toBeNull();
    expect(result.current.unconfirmedSend?.request.question).toBe('问题');
    expect(pendingChatRequestStore.get(session.id)?.clientRequestId).toBe(
      result.current.unconfirmedSend?.request.clientRequestId,
    );
  });

  it('keeps a partial answer visible when the user stops generation', async () => {
    let handlers: { onDelta?: (text: string) => void } | undefined;
    let rejectStream!: (reason?: unknown) => void;
    resourceMocks.sendChatMessageStream.mockImplementation((
      _sessionId: string,
      _input: unknown,
      nextHandlers: { onDelta?: (text: string) => void },
      signal?: AbortSignal,
    ) => {
      handlers = nextHandlers;
      return new Promise((_resolve, reject) => {
        rejectStream = reject;
        signal?.addEventListener('abort', () => rejectStream(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });

    const { result } = renderThread();
    await settleEffects();
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.send('问题');
    });
    await waitFor(() => expect(handlers).toBeTruthy());
    act(() => handlers?.onDelta?.('半截回答'));
    act(() => result.current.cancelSend());
    await act(async () => { await sendPromise; });
    await waitFor(() => expect(result.current.stoppedStream?.answer).toBe('半截回答'));
    expect(result.current.unconfirmedSend).toBeNull();
    expect(result.current.sending).toBe(false);
  });

  it('aborts the active stream when the thread unmounts', async () => {
    let receivedSignal: AbortSignal | undefined;
    resourceMocks.sendChatMessageStream.mockImplementation((
      _sessionId: string,
      _input: unknown,
      _handlers: unknown,
      signal?: AbortSignal,
    ) => {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });

    const { result, unmount } = renderThread();
    await settleEffects();

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('问题');
    });
    await settleEffects();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);

    unmount();
    expect(receivedSignal?.aborted).toBe(true);
    await act(async () => {
      await sending;
    });
  });

  it('treats status zero as an unknown result', async () => {
    resourceMocks.sendChatMessageStream.mockRejectedValue(
      new ApiError(0, { code: 'NETWORK_ERROR', message: '网络异常' }),
    );

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.send('问题');
    });

    expect(result.current.failedSend).toBeNull();
    expect(result.current.unconfirmedSend?.request.question).toBe('问题');
  });

  it('treats a network exception as an unknown result', async () => {
    resourceMocks.sendChatMessageStream.mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.send('问题');
    });

    expect(result.current.failedSend).toBeNull();
    expect(result.current.unconfirmedSend?.request.question).toBe('问题');
  });

  it('treats only an explicit HTTP 4xx response as a definitive failure', async () => {
    resourceMocks.sendChatMessageStream.mockRejectedValue(
      new ApiError(400, { code: 'VALIDATION_ERROR', message: '参数错误' }),
    );

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.send('问题');
    });

    expect(result.current.failedSend).toEqual({ question: '问题', message: '参数错误' });
    expect(result.current.unconfirmedSend).toBeNull();
    expect(pendingChatRequestStore.get(session.id)).toBeNull();
  });

  it('routes a send 429 to the composer instead of the failed-answer state', async () => {
    resourceMocks.sendChatMessageStream.mockRejectedValue(
      new ApiError(429, {
        code: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后重试',
        details: { retryAfter: 14 },
      }),
    );

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.send('问题');
    });

    expect(result.current.rateLimitError).toBe('请求过于频繁，请 14 秒后再试');
    expect(result.current.rateLimitedQuestion).toBe('问题');
    expect(result.current.failedSend).toBeNull();
    expect(result.current.unconfirmedSend).toBeNull();
    expect(pendingChatRequestStore.get(session.id)).toBeNull();
  });

  it('routes a regenerate 429 to the composer and clears recovery storage', async () => {
    resourceMocks.regenerateChatMessage.mockRejectedValue(
      new ApiError(429, {
        code: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后重试',
        details: { retryAfter: 8 },
      }),
    );

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.regenerate('assistant-message-1');
    });

    expect(result.current.rateLimitError).toBe('请求过于频繁，请 8 秒后再试');
    expect(result.current.rateLimitedQuestion).toBeNull();
    expect(result.current.regeneration).toBeNull();
    expect(window.localStorage.getItem(`rag.chat.pending-regeneration:${session.id}`)).toBeNull();
  });

  it('treats an explicit chat generation failure as definitive', async () => {
    resourceMocks.sendChatMessageStream.mockRejectedValue(
      new ApiError(500, { code: 'CHAT_COMPLETION_FAILED', message: '生成失败' }),
    );

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.send('问题');
    });

    expect(result.current.failedSend).toEqual({
      question: '问题',
      message: '回答生成失败，请稍后重试。',
    });
    expect(result.current.unconfirmedSend).toBeNull();
    expect(pendingChatRequestStore.get(session.id)).toBeNull();
  });

  it('reuses the original clientRequestId when resending an unknown result', async () => {
    resourceMocks.sendChatMessageStream
      .mockRejectedValueOnce(new ApiError(0, { code: 'STREAM_INCOMPLETE', message: '连接已中断' }))
      .mockResolvedValueOnce(completedResponse);

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.send('问题');
    });
    const originalId = result.current.unconfirmedSend?.request.clientRequestId;

    await act(async () => {
      await result.current.send('问题', { resend: true });
    });

    const firstInput = resourceMocks.sendChatMessageStream.mock.calls[0][1] as { clientRequestId: string };
    const secondInput = resourceMocks.sendChatMessageStream.mock.calls[1][1] as { clientRequestId: string };
    expect(originalId).toBeTruthy();
    expect(firstInput.clientRequestId).toBe(originalId);
    expect(secondInput.clientRequestId).toBe(originalId);
  });

  it('adopts a committed assistant message during reconciliation without sending again', async () => {
    vi.useFakeTimers();
    resourceMocks.sendChatMessageStream.mockRejectedValue(
      new ApiError(0, { code: 'STREAM_INCOMPLETE', message: '连接已中断' }),
    );

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.send('问题');
    });
    const clientRequestId = result.current.unconfirmedSend?.request.clientRequestId;
    expect(clientRequestId).toBeTruthy();

    resourceMocks.listChatMessages.mockResolvedValue({ items: messagesFor(clientRequestId as string) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.unconfirmedSend).toBeNull();
    expect(result.current.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(resourceMocks.sendChatMessageStream).toHaveBeenCalledTimes(1);
    expect(pendingChatRequestStore.get(session.id)).toBeNull();
  });

  it('restores automatic reconciliation for a pending request from storage', async () => {
    vi.useFakeTimers();
    pendingChatRequestStore.set({
      sessionId: session.id,
      question: '刷新前的问题',
      clientRequestId: '35d43d04-6a02-4bb2-96f4-8d557264cbe4',
      createdAt: '2026-08-10T00:00:00Z',
    });

    const { result } = renderThread();
    await settleEffects();

    expect(result.current.unconfirmedSend?.autoChecksDone).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(resourceMocks.listChatMessages).toHaveBeenCalledTimes(3);
    expect(result.current.unconfirmedSend?.autoChecksDone).toBe(2);
    expect(result.current.needsResendDecision).toBe(true);
  });

  it('keeps automatic reconciliation running when the caller callback identity changes', async () => {
    vi.useFakeTimers();
    const check = deferred<{ items: ChatMessage[] }>();
    resourceMocks.listChatMessages
      .mockResolvedValueOnce({ items: [] })
      .mockReturnValueOnce(check.promise);
    pendingChatRequestStore.set({
      sessionId: session.id,
      question: '刷新前的问题',
      clientRequestId: '769df4ac-4de4-46f1-9c7c-4b662bd75ab3',
      createdAt: '2026-08-10T00:00:00Z',
    });

    const { result } = renderThreadWithChangingSessionsCallback();
    await settleEffects();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      check.resolve({ items: [] });
      await Promise.resolve();
    });

    expect(resourceMocks.listChatMessages).toHaveBeenCalledTimes(2);
    expect(result.current.unconfirmedSend).toEqual(expect.objectContaining({
      autoChecksDone: 1,
      checking: false,
    }));
  });

  it('finishes a manual reconciliation when the caller callback identity changes', async () => {
    const check = deferred<{ items: ChatMessage[] }>();
    resourceMocks.listChatMessages
      .mockResolvedValueOnce({ items: [] })
      .mockReturnValueOnce(check.promise);
    pendingChatRequestStore.set({
      sessionId: session.id,
      question: '需要手动核对的问题',
      clientRequestId: '68b506a1-072a-4412-ab47-736c736babd2',
      createdAt: '2026-08-10T00:00:00Z',
    });

    const { result } = renderThreadWithChangingSessionsCallback();
    await settleEffects();

    let checking: Promise<void> | undefined;
    act(() => {
      checking = result.current.checkSendNow();
    });
    await act(async () => {
      check.resolve({ items: [] });
      await checking;
    });

    expect(result.current.unconfirmedSend).toEqual(expect.objectContaining({
      autoChecksDone: 2,
      checking: false,
    }));
  });

  it('ignores an older automatic reconciliation response that resolves last', async () => {
    vi.useFakeTimers();
    const firstCheck = deferred<{ items: ChatMessage[] }>();
    const secondCheck = deferred<{ items: ChatMessage[] }>();
    const newerMessages: ChatMessage[] = [{
      id: 'newer-message',
      sessionId: session.id,
      clientRequestId: null,
      role: 'assistant',
      content: '较新的会话快照',
      citations: [],
      createdAt: '2026-08-10T00:00:03Z',
    }];
    resourceMocks.listChatMessages
      .mockResolvedValueOnce({ items: [] })
      .mockReturnValueOnce(firstCheck.promise)
      .mockReturnValueOnce(secondCheck.promise);
    resourceMocks.sendChatMessageStream.mockRejectedValue(
      new ApiError(0, { code: 'STREAM_INCOMPLETE', message: '连接已中断' }),
    );

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.send('问题');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(3000);
    });

    await act(async () => {
      secondCheck.resolve({ items: newerMessages });
      await Promise.resolve();
    });
    expect(result.current.messages).toEqual(newerMessages);
    expect(result.current.unconfirmedSend?.autoChecksDone).toBe(2);

    await act(async () => {
      firstCheck.resolve({ items: [] });
      await Promise.resolve();
    });

    expect(result.current.messages).toEqual(newerMessages);
    expect(result.current.unconfirmedSend?.autoChecksDone).toBe(2);
  });
});
