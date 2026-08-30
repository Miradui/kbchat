import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import type {
  ChatKnowledgeGapListResponse,
  ChatQualityFeedbackListResponse,
  ChatQualityOverview,
  KnowledgeBase,
} from '../../types/api';
import { QualityPage } from './QualityPage';

vi.mock('../../api/resources', () => ({
  getChatQualityOverview: vi.fn(),
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员' }),
  listChatKnowledgeGaps: vi.fn(),
  listKnowledgeBases: vi.fn(),
  listNegativeChatFeedback: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}));

const overview: ChatQualityOverview = {
  period: 'month', startAt: '2026-08-01T00:00:00Z', endAt: '2026-08-19T00:00:00Z',
  answerCount: 10, feedbackCount: 6, positiveFeedbackCount: 4, negativeFeedbackCount: 2,
  knowledgeAnswerCount: 6, withoutCitationsCount: 3, unclassifiedAnswerCount: 0,
  feedbackCoverage: 0.6, positiveRate: 2 / 3, withoutCitationsRate: 0.5,
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

const gaps: ChatKnowledgeGapListResponse = {
  total: 2, page: 1, pageSize: 10, noCitationsTotal: 1, repeatedRewriteTotal: 1, items: [
    {
      category: 'no_citations', messageId: 'message-2', sessionId: 'session-1', sessionTitle: '退货政策',
      knowledgeBaseId: 'kb-1', knowledgeBaseName: '产品知识库', question: '支持跨境退货吗？',
      retrievalQuery: '跨境退货', occurrenceCount: 1, ungroundedCount: 1,
      firstSeenAt: '2026-08-12T00:00:00Z', lastSeenAt: '2026-08-12T00:00:00Z',
    },
    {
      category: 'repeated_rewrite', messageId: null, sessionId: 'session-2', sessionTitle: '发票问题',
      knowledgeBaseId: 'kb-1', knowledgeBaseName: '产品知识库', question: '发票要求',
      retrievalQuery: '发票要求', occurrenceCount: 3, ungroundedCount: 2,
      firstSeenAt: '2026-08-13T00:00:00Z', lastSeenAt: '2026-08-14T00:00:00Z',
    },
  ],
};

function createSources() {
  return {
    loadOverview: vi.fn().mockResolvedValue(overview),
    loadFeedback: vi.fn().mockResolvedValue(feedback),
    loadKnowledgeGaps: vi.fn().mockResolvedValue(gaps),
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
    // Gap rows link to sessions too, so this stays scoped to the feedback panel.
    const feedbackPanel = screen.getByRole('region', { name: '负反馈列表' });
    expect(within(feedbackPanel).getByRole('link', { name: /查看会话/ })).toHaveAttribute('href', '/chat/session-1');
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

  it('shows both knowledge gap categories with their occurrence counts and links', async () => {
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    expect(await screen.findByText('支持跨境退货吗？')).toBeInTheDocument();
    expect(screen.getByText('发票要求')).toBeInTheDocument();
    // A cluster reports its size and how much of it was ungrounded; a single
    // ungrounded answer reports neither, because both would always be 1.
    expect(screen.getByText('改写 3 次')).toBeInTheDocument();
    expect(screen.getByText('其中 2 次无引用')).toBeInTheDocument();
    // Per-category totals label the filter without a second request.
    expect(screen.getByRole('option', { name: '检索无结果 (1)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '反复改写 (1)' })).toBeInTheDocument();
    const supplementLinks = screen.getAllByRole('link', { name: /补充资料/ });
    expect(supplementLinks[0]).toHaveAttribute('href', '/knowledge-bases/kb-1/documents');
  });

  it('requests one gap category and resets paging when the filter changes', async () => {
    const user = userEvent.setup();
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);
    await screen.findByText('支持跨境退货吗？');

    // "all" is the default and is not sent, since the API already treats an
    // absent category as both.
    expect(sources.loadKnowledgeGaps).toHaveBeenLastCalledWith(expect.not.objectContaining({
      category: expect.anything(),
    }));

    await user.selectOptions(screen.getByRole('combobox', { name: '知识缺口类型' }), 'repeated_rewrite');

    await waitFor(() => expect(sources.loadKnowledgeGaps).toHaveBeenLastCalledWith(expect.objectContaining({
      category: 'repeated_rewrite', page: 1, pageSize: 10, period: 'month',
    })));
    // Changing the gap filter must not re-request the negative feedback list.
    expect(sources.loadFeedback).toHaveBeenCalledTimes(1);
  });

  it('discloses that pre-intent answers are excluded from the no-citation rate', async () => {
    const sources = createSources();
    sources.loadOverview.mockResolvedValue({ ...overview, unclassifiedAnswerCount: 4 });
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    expect(await screen.findByText(/4 条回答早于意图记录/)).toBeInTheDocument();
  });

  it('explains an empty gap list per category', async () => {
    const user = userEvent.setup();
    const sources = createSources();
    sources.loadKnowledgeGaps.mockResolvedValue({
      ...gaps, total: 0, items: [], noCitationsTotal: 0, repeatedRewriteTotal: 0,
    });
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    expect(await screen.findByText('当前周期内没有检索失败或被反复改写的问题。')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: '知识缺口类型' }), 'no_citations');

    expect(await screen.findByText('当前周期内的知识型提问都检索到了内容。')).toBeInTheDocument();
  });
});
