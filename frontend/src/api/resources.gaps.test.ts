import { describe, expect, it, vi } from 'vitest';

import { apiBlobRequest, apiRequest, apiUploadRequest } from './client';
import {
  exportChatSession,
  exportGlobalSearch,
  getChatQualityOverview,
  getSystemCapabilities,
  listChatSessions,
  listNegativeChatFeedback,
  listDocuments,
  setChatMessageFeedback,
  unarchiveChatSession,
  uploadDocument,
} from './resources';

vi.mock('./client', () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn(), apiUploadRequest: vi.fn() }));

describe('frontend gap resources', () => {
  it('sends session list filters as query parameters', () => {
    vi.mocked(apiRequest).mockResolvedValue({});

    void listChatSessions({
      archived: true,
      knowledgeBaseId: 'kb-1',
      q: '退货',
      page: 2,
      pageSize: 50,
    });

    expect(apiRequest).toHaveBeenCalledWith(
      '/chat/sessions?archived=true&knowledgeBaseId=kb-1&q=%E9%80%80%E8%B4%A7&page=2&pageSize=50',
    );
  });

  it('keeps an unfiltered session list free of query parameters', () => {
    vi.mocked(apiRequest).mockResolvedValue({});

    void listChatSessions();

    expect(apiRequest).toHaveBeenCalledWith('/chat/sessions');
  });

  it('posts an unarchive request for a session', () => {
    vi.mocked(apiRequest).mockResolvedValue({});

    void unarchiveChatSession('session-1');

    expect(apiRequest).toHaveBeenCalledWith('/chat/sessions/session-1/unarchive', {
      method: 'POST',
    });
  });

  it('scopes the document list query to the knowledge base in the path', () => {
    vi.mocked(apiRequest).mockResolvedValue({});

    void listDocuments('kb-1', { status: 'failed', page: 1, pageSize: 6 });

    expect(apiRequest).toHaveBeenCalledWith(
      '/knowledge-bases/kb-1/documents?status=failed&page=1&pageSize=6',
    );
  });

  it('reads system capabilities', () => {
    vi.mocked(apiRequest).mockResolvedValue({});

    void getSystemCapabilities();

    expect(apiRequest).toHaveBeenCalledWith('/system/capabilities');
  });

  it('posts assistant feedback and exports chat/search downloads', () => {
    vi.mocked(apiRequest).mockResolvedValue({});
    vi.mocked(apiBlobRequest).mockResolvedValue(new Blob());

    void setChatMessageFeedback('message-1', 'positive');
    void exportChatSession('session-1');
    void exportGlobalSearch({ query: '退货', type: 'document' });

    expect(apiRequest).toHaveBeenCalledWith('/chat/messages/message-1/feedback', {
      method: 'POST',
      body: { rating: 'positive' },
    });
    expect(apiBlobRequest).toHaveBeenCalledWith('/chat/sessions/session-1/export');
    expect(apiBlobRequest).toHaveBeenCalledWith('/search/export?q=%E9%80%80%E8%B4%A7&type=document');
  });

  it('loads quality overview and filtered negative feedback with encoded params', () => {
    vi.mocked(apiRequest).mockResolvedValue({});

    void getChatQualityOverview({ period: 'day', knowledgeBaseId: 'kb-1' });
    void listNegativeChatFeedback({
      period: 'month',
      knowledgeBaseId: 'kb-1',
      hasCitations: false,
      page: 2,
      pageSize: 10,
    });

    expect(apiRequest).toHaveBeenCalledWith('/chat/quality/overview?period=day&knowledgeBaseId=kb-1');
    expect(apiRequest).toHaveBeenCalledWith(
      '/chat/quality/negative-feedback?period=month&knowledgeBaseId=kb-1&hasCitations=false&page=2&pageSize=10',
    );
  });

  it('uses the progress-aware upload transport', () => {
    vi.mocked(apiUploadRequest).mockResolvedValue({});
    const file = new File(['content'], 'policy.md', { type: 'text/markdown' });
    const onProgress = vi.fn();

    void uploadDocument('kb-1', file, onProgress);

    expect(apiUploadRequest).toHaveBeenCalledWith(
      '/knowledge-bases/kb-1/documents',
      expect.any(FormData),
      { onProgress },
    );
  });
});
