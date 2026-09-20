import { describe, expect, it } from 'vitest';

import { ApiError, apiEventStream } from './client';
import { tokenStore } from '../store/tokenStore';

/** Feeds the response body in caller-controlled pieces to exercise buffering. */
function respondWith(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function collect(chunks: string[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(respondWith(chunks))) as typeof fetch;
  try {
    const events = [];
    for await (const event of apiEventStream('/stream')) events.push(event);
    return events;
  } finally {
    globalThis.fetch = originalFetch;
    tokenStore.clearToken();
  }
}

describe('apiEventStream', () => {
  it('surfaces a pre-stream 429 with its retry delay', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({
      code: 'RATE_LIMITED',
      message: '请求过于频繁，请稍后重试',
      details: { retryAfter: 30 },
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '9' },
    }))) as typeof fetch;

    try {
      let caught: unknown;
      try {
        for await (const _event of apiEventStream('/stream')) {
          // A rate-limited response never opens an event stream.
        }
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
        retryAfterSeconds: 9,
        message: '请求过于频繁，请 9 秒后再试',
      });
    } finally {
      globalThis.fetch = originalFetch;
      tokenStore.clearToken();
    }
  });

  it('parses event and data fields into frames', async () => {
    const events = await collect([
      'event: citations\ndata: {"citations":[]}\n\n',
      'event: delta\ndata: {"text":"你好"}\n\n',
    ]);

    expect(events).toEqual([
      { event: 'citations', data: '{"citations":[]}' },
      { event: 'delta', data: '{"text":"你好"}' },
    ]);
  });

  // Network chunks do not align with frames, so a frame split across two reads
  // has to survive. Getting this wrong drops or corrupts tokens under load.
  it('reassembles a frame split across chunk boundaries', async () => {
    const events = await collect(['event: del', 'ta\ndata: {"te', 'xt":"三十天"}\n', '\n']);

    expect(events).toEqual([{ event: 'delta', data: '{"text":"三十天"}' }]);
  });

  it('handles several frames arriving in one chunk', async () => {
    const events = await collect([
      'event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"text":"b"}\n\n',
    ]);

    expect(events.map((event) => event.data)).toEqual(['{"text":"a"}', '{"text":"b"}']);
  });

  it('ignores comments and keep-alive padding', async () => {
    const events = await collect([
      ': keep-alive\n\n',
      'event: delta\ndata: {"text":"a"}\n\n',
    ]);

    expect(events).toEqual([{ event: 'delta', data: '{"text":"a"}' }]);
  });

  it('tolerates CRLF line endings from a proxy', async () => {
    const events = await collect(['event: delta\r\ndata: {"text":"a"}\r\n\r\n']);

    expect(events).toEqual([{ event: 'delta', data: '{"text":"a"}' }]);
  });

  it('drops a trailing partial frame rather than emitting a truncated one', async () => {
    const events = await collect([
      'event: delta\ndata: {"text":"a"}\n\n',
      'event: delta\ndata: {"tex',
    ]);

    expect(events).toEqual([{ event: 'delta', data: '{"text":"a"}' }]);
  });
});
