import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import type { ChatQualityFeedbackListResponse, ChatQualityOverview, KnowledgeBase } from '../../types/api';
import { QualityPage } from './QualityPage';

vi.mock('../../api/resources', () => ({
  getChatQualityOverview: vi.fn(),
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员' }),
  listKnowledgeBases: vi.fn(),
  listNegativeChatFeedback: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}));

const overview: ChatQualityOverview = {
  period: 'month', startAt: '2026-08-01T00:00:00Z', endAt: '2026-08-19T00:00:00Z',
  answerCount: 10, feedbackCount: 6, positiveFeedbackCount: 4, negativeFeedbackCount: 2,
  withoutCitationsCount: 3, feedbackCoverage: 0.6, positiveRate: 2 / 3,
};

const knowledgeBase: KnowledgeBase = {
  id: 'kb-1', name: '产品知识库', description: '', retrievalConfig: {
    vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true,
  }, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};

const feedback: ChatQualityFeedbackListResponse = {
  total: 1, page: 1, pageSize: 10, items: [{
    messageId: 'message-1', sessionId: 'session-1', sessionTitle: '退货政策',
    knowledgeBaseId: 'kb-1', knowledgeBaseName: '产品知识库', question: '如何退货？',
    answer: '请在三十天内申请。', citations: [{
      documentId: 'doc-1', chunkId: 'chunk-1', filename: 'policy.pdf', pageNumber: 3,
      content: '三十天内可退货。', vectorScore: 0.8, rerankScore: 0.9,
    }], rerankFallback: { used: true, reason: 'provider timeout' },
    createdAt: '2026-08-10T00:00:00Z', feedbackUpdatedAt: '2026-08-11T00:00:00Z',
  }],
};

function createSources() {
  return {
    loadOverview: vi.fn().mockResolvedValue(overview),
    loadFeedback: vi.fn().mockResolvedValue(feedback),
    loadKnowledgeBases: vi.fn().mockResolvedValue([knowledgeBase]),
  };
}

describe('QualityPage', () => {
  it('shows quality metrics, evidence and session navigation', async () => {
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    expect(await screen.findByText('RAG 质量运营')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('如何退货？')).toBeInTheDocument();
    expect(screen.getByText('policy.pdf · 第 3 页')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /查看会话/ })).toHaveAttribute('href', '/chat/session-1');
  });

  it('reloads both requests when filters change and keeps the latest filter', async () => {
    const user = userEvent.setup();
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);
    await screen.findByText('如何退货？');

    await user.selectOptions(screen.getByRole('combobox', { name: '负反馈引用筛选' }), 'without');

    await waitFor(() => expect(sources.loadFeedback).toHaveBeenLastCalledWith(expect.objectContaining({
      hasCitations: false, page: 1, pageSize: 10,
    })));
    expect(sources.loadOverview).toHaveBeenCalled();
  });
});
