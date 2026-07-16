import { describe, expect, it, vi } from 'vitest';

import { apiRequest } from './client';
import * as resources from './resources';

vi.mock('./client', () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn() }));

describe('RAG resources', () => {
  it('posts an assistant message regeneration request', async () => {
    const regenerate = (resources as typeof resources & {
      regenerateChatMessage?: (sessionId: string, messageId: string) => Promise<unknown>;
    }).regenerateChatMessage;

    expect(regenerate).toBeTypeOf('function');
    vi.mocked(apiRequest).mockResolvedValue({ message: {}, rerankFallback: null });

    await regenerate?.('session-1', 'message-1');

    expect(apiRequest).toHaveBeenCalledWith('/chat/sessions/session-1/messages/message-1/regenerate', {
      method: 'POST',
    });
  });
});
