import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { ApiError, apiRequest } from './client';
import { sendChatMessageStream } from './resources';
import { getErrorMessage } from '../utils/errors';

afterEach(() => vi.unstubAllGlobals());

// Only fetch is replaced: the production HTTP/SSE clients and public error
// presentation must preserve one ID from a failed response through to the user.
it('carries HTTP and SSE failure trace IDs to user-facing errors', async () => {
  const traceId = '0123456789abcdef0123456789abcdef';
  const payload = { code: 'CHAT_COMPLETION_FAILED', message: 'upstream internal detail', traceId };
  const results: Record<string, boolean> = {};
  for (const mode of ['json', 'sse'] as const) {
    vi.stubGlobal('fetch', vi.fn(async () => mode === 'json'
      ? Response.json(payload, { status: 503 })
      : new Response(`event: error\ndata: ${JSON.stringify({ ...payload, status: 503 })}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      })));
    let caught: unknown;
    try {
      if (mode === 'json') await apiRequest('/fixture');
      else await sendChatMessageStream('fixture', { content: 'question', clientRequestId: 'request' });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ traceId, status: 503 });
    const message = getErrorMessage(caught, '回答失败');
    expect(message).toContain(traceId);
    expect(message).not.toContain('upstream internal detail');
    results[`${mode}TraceVisible`] = true;
  }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...payload, traceId: '<invalid>' }, { status: 503 })));
  const invalid = await apiRequest('/fixture').catch((error: unknown) => error);
  expect(getErrorMessage(invalid, '回答失败')).not.toContain('<invalid>');
  results.invalidTraceHidden = true;
  const directory = resolve('src/test/fixtures/observability/runs/latest');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'result.json'), `${JSON.stringify(results, null, 2)}\n`);
});
