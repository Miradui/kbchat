import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './client';
import { sendChatMessageStream } from './resources';
import type { SendChatMessageResponse } from '../types/api';

const { apiEventStreamMock } = vi.hoisted(() => ({ apiEventStreamMock: vi.fn() }));

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return {
    ...actual,
    apiRequest: vi.fn(),
    apiBlobRequest: vi.fn(),
    apiEventStream: apiEventStreamMock,
  };
});

function streamOf(frames: Array<{ event: string; data: unknown }>) {
  return async function* () {
    for (const frame of frames) {
      yield { event: frame.event, data: JSON.stringify(frame.data) };
    }
  };
}

const donePayload: SendChatMessageResponse = {
  clientRequestId: 'req-1',
  userMessage: {
    id: 'm1', sessionId: 's1', clientRequestId: 'req-1', role: 'user',
    content: '退货政策是什么', citations: [], createdAt: '2026-08-09T00:00:00Z',
  },
  assistantMessage: {
    id: 'm2', sessionId: 's1', clientRequestId: 'req-1', role: 'assistant',
    content: '三十天内可退', citations: [], createdAt: '2026-08-09T00:00:01Z',
  },
  answer: '三十天内可退',
  citations: [],
  rerankFallback: null,
};

describe('sendChatMessageStream', () => {
  it('reports citations and deltas in order and resolves with the done payload', async () => {
    apiEventStreamMock.mockImplementation(streamOf([
      { event: 'citations', data: { citations: [{ chunkId: 'c1' }] } },
      { event: 'delta', data: { text: '三十天' } },
      { event: 'delta', data: { text: '内可退' } },
      { event: 'done', data: donePayload },
    ]));

    const deltas: string[] = [];
    const citations: unknown[][] = [];
    const result = await sendChatMessageStream(
      's1',
      { content: '退货政策是什么', clientRequestId: 'req-1' },
      { onDelta: (text) => deltas.push(text), onCitations: (items) => citations.push(items) },
    );

    expect(citations).toEqual([[{ chunkId: 'c1' }]]);
    expect(deltas.join('')).toBe('三十天内可退');
    expect(result.answer).toBe('三十天内可退');
    expect(result.assistantMessage.id).toBe('m2');
  });

  it('posts to the stream endpoint carrying the idempotency key', async () => {
    apiEventStreamMock.mockImplementation(streamOf([{ event: 'done', data: donePayload }]));

    await sendChatMessageStream('s1', { content: 'q', clientRequestId: 'req-1' });

    expect(apiEventStreamMock).toHaveBeenCalledWith(
      '/chat/sessions/s1/messages/stream',
      expect.objectContaining({
        method: 'POST',
        body: { content: 'q', clientRequestId: 'req-1' },
      }),
    );
  });

  // A mid-stream error event must surface with the same code a JSON error would,
  // so the caller's existing error classification keeps working.
  it('turns an error event into an ApiError with the server code', async () => {
    apiEventStreamMock.mockImplementation(streamOf([
      { event: 'delta', data: { text: '部分' } },
      { event: 'error', data: { status: 500, code: 'CHAT_COMPLETION_FAILED', message: '回答生成失败' } },
    ]));

    await expect(
      sendChatMessageStream('s1', { content: 'q', clientRequestId: 'req-1' }),
    ).rejects.toMatchObject({ code: 'CHAT_COMPLETION_FAILED', status: 500 });
  });

  // G2: a stream that stops without `done` is an unknown result, not a success.
  // Resolving here would let the caller clear the pending request and skip
  // reconciliation, which is exactly how a lost answer would go unnoticed.
  it('rejects when the stream ends without a done event', async () => {
    apiEventStreamMock.mockImplementation(streamOf([
      { event: 'citations', data: { citations: [] } },
      { event: 'delta', data: { text: '半句话' } },
    ]));

    const error = await sendChatMessageStream('s1', { content: 'q', clientRequestId: 'req-1' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('STREAM_INCOMPLETE');
  });

  it('stops consuming once done arrives', async () => {
    const afterDone = vi.fn();
    apiEventStreamMock.mockImplementation(async function* () {
      yield { event: 'done', data: JSON.stringify(donePayload) };
      afterDone();
      yield { event: 'delta', data: JSON.stringify({ text: 'ignored' }) };
    });

    const deltas: string[] = [];
    await sendChatMessageStream('s1', { content: 'q', clientRequestId: 'req-1' }, {
      onDelta: (text) => deltas.push(text),
    });

    expect(deltas).toEqual([]);
    expect(afterDone).not.toHaveBeenCalled();
  });

  it('ignores a malformed frame instead of failing the whole answer', async () => {
    apiEventStreamMock.mockImplementation(async function* () {
      yield { event: 'delta', data: '{not json' };
      yield { event: 'delta', data: JSON.stringify({ text: '完整' }) };
      yield { event: 'done', data: JSON.stringify(donePayload) };
    });

    const deltas: string[] = [];
    const result = await sendChatMessageStream('s1', { content: 'q', clientRequestId: 'req-1' }, {
      onDelta: (text) => deltas.push(text),
    });

    expect(deltas).toEqual(['完整']);
    expect(result.answer).toBe('三十天内可退');
  });
});
