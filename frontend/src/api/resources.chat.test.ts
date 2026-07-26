import { describe, expect, it, vi } from 'vitest';

import { apiRequest } from './client';
import { sendChatMessage } from './resources';

vi.mock('./client', () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn() }));

describe('chat resources', () => {
  it('sends the stable client request id with the message content', () => {
    vi.mocked(apiRequest).mockResolvedValue({});

    void sendChatMessage('session-1', {
      content: 'How do I submit an expense?',
      clientRequestId: '4c6b6701-c6dd-4804-9f95-826df9ccff91',
    });

    expect(apiRequest).toHaveBeenCalledWith('/chat/sessions/session-1/messages', {
      method: 'POST',
      body: {
        content: 'How do I submit an expense?',
        clientRequestId: '4c6b6701-c6dd-4804-9f95-826df9ccff91',
      },
    });
  });
});
