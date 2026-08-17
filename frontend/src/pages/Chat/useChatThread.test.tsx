import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import type { ChatMessage, ChatSession, SendChatMessageResponse } from '../../types/api';
import { pendingChatRequestStore } from './pendingChatRequestStore';
import { useChatThread } from './useChatThread';

const resourceMocks = vi.hoisted(() => ({
  createChatSession: vi.fn(),
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
  answer: '完整回答',
  citations: [],
  rerankFallback: null,
};

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
  const hook = renderHook(() => useChatThread({
    sessionId: session.id,
    onSessionCreated,
    onSessionsChanged,
  }));
  return { ...hook, onSessionCreated, onSessionsChanged };
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

    expect(result.current.streamingAnswer).toBe('');
    expect(result.current.failedSend).toBeNull();
    expect(result.current.unconfirmedSend?.request.question).toBe('问题');
    expect(pendingChatRequestStore.get(session.id)?.clientRequestId).toBe(
      result.current.unconfirmedSend?.request.clientRequestId,
    );
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

  it('does not classify a 5xx stream error as a definitive failure', async () => {
    resourceMocks.sendChatMessageStream.mockRejectedValue(
      new ApiError(500, { code: 'CHAT_COMPLETION_FAILED', message: '生成失败' }),
    );

    const { result } = renderThread();
    await settleEffects();

    await act(async () => {
      await result.current.send('问题');
    });

    expect(result.current.failedSend).toBeNull();
    expect(result.current.unconfirmedSend?.request.question).toBe('问题');
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
