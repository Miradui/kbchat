import { StrictMode } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../components/feedback/ToastProvider';
import { renderWithRouter } from '../../test/render';
import type { GlobalDocumentItem, HomeSummaryResponse, KnowledgeBase } from '../../types/api';
import type { HomeSources } from './homeData';
import { HomePage } from './HomePage';

const knowledgeBase = { id: 'kb1', name: '员工手册', description: '制度资料', visibility: 'private', retrievalConfig: { vectorTopN: 20, rerankTopK: 5, scoreThreshold: 0.2, enableRerank: true }, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z' } satisfies KnowledgeBase;
const document = { id: 'd1', knowledgeBaseId: 'kb1', knowledgeBaseName: '员工手册', filename: 'handbook.pdf', fileType: 'pdf', fileSize: 120, status: 'completed', errorMessage: null, createdAt: '2026-07-02T00:00:00Z' } satisfies GlobalDocumentItem;

// G17: the page is fed by one aggregate response instead of four list calls.
function createSummary(overrides: Partial<HomeSummaryResponse> = {}): HomeSummaryResponse {
  return {
    period: 'month',
    stats: {
      period: 'month',
      knowledgeBases: { value: 1, changeRatio: 0 },
      documents: { value: 1, changeRatio: 0 },
      views: { value: 0, changeRatio: 0 },
      questions: { value: 0, changeRatio: 0 },
    },
    knowledgeBases: [knowledgeBase],
    knowledgeBaseTotal: 1,
    documents: [document],
    documentTotal: 1,
    failedDocuments: [],
    failedDocumentTotal: 0,
    sessions: [],
    sessionTotal: 0,
    ...overrides,
  };
}

function createSources(): HomeSources {
  return {
    loadSummary: vi.fn().mockResolvedValue(createSummary()),
    loadActivities: vi.fn().mockResolvedValue([]),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('HomePage', () => {
  it('does not present a deliberately cancelled document as a processing failure', async () => {
    const sources = createSources();
    vi.mocked(sources.loadSummary).mockResolvedValue(createSummary({
      failedDocuments: [{ ...document, status: 'failed', jobStatus: 'cancelled' }],
      failedDocumentTotal: 1,
    }));
    renderWithRouter(<HomePage sources={sources} />);

    await screen.findByText('还没有动态');
    expect(screen.queryByRole('region', { name: '需要处理' })).not.toBeInTheDocument();
  });

  it('opens the import dialog from the home shortcut', async () => {
    renderWithRouter(<HomePage sources={createSources()} />);
    expect(await screen.findByRole('link', { name: /导入文档/ })).toHaveAttribute('href', '/documents?intent=upload');
  });

  it('links the primary knowledge-base action to the create intent', async () => {
    renderWithRouter(<HomePage sources={createSources()} />);

    expect(await screen.findByRole('link', { name: /新建知识库/ })).toHaveAttribute(
      'href',
      '/knowledge-bases?intent=create',
    );
  });

  it('opens the conversation workspace from the quick actions', async () => {
    renderWithRouter(<HomePage sources={createSources()} />);

    expect(await screen.findByRole('link', { name: /查看会话/ })).toHaveAttribute('href', '/chat');
  });

  // G18: the timeline is the recorded activity feed, not a merge of the lists.
  it('links document activity directly to the document detail', async () => {
    const sources = createSources();
    vi.mocked(sources.loadActivities).mockResolvedValue([{
      id: 'a1',
      action: 'document.uploaded',
      resourceType: 'document',
      resourceId: 'd1',
      resourceName: 'handbook.pdf',
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: '员工手册',
      createdAt: '2026-07-02T00:00:00Z',
    }]);
    renderWithRouter(<HomePage sources={sources} />);

    const activity = await screen.findByRole('link', { name: /handbook\.pdf/ });
    expect(activity).toHaveAttribute(
      'href',
      '/knowledge-bases/kb1/documents?documentId=d1',
    );
    expect(activity).toHaveTextContent('导入了文档');
    expect(activity).not.toHaveTextContent('document.uploaded');
  });

  // G18: a delete has no page to open, so it points at the list instead of a
  // route that would 404.
  it('sends deleted-resource activity to the list rather than a dead route', async () => {
    const sources = createSources();
    vi.mocked(sources.loadActivities).mockResolvedValue([{
      id: 'a2',
      action: 'knowledgeBase.deleted',
      resourceType: 'knowledgeBase',
      resourceId: 'kb9',
      resourceName: '已删除知识库',
      knowledgeBaseId: 'kb9',
      knowledgeBaseName: '已删除知识库',
      createdAt: '2026-07-02T00:00:00Z',
    }]);
    renderWithRouter(<HomePage sources={sources} />);

    const activity = await screen.findByRole('link', { name: /已删除知识库/ });
    expect(activity).toHaveAttribute('href', '/knowledge-bases');
  });

  // G17 folded the four list calls into one request, so those four regions now
  // fail together. The timeline is a separate resource and stays independent.
  it('keeps the timeline visible when the summary request fails', async () => {
    const sources = createSources();
    vi.mocked(sources.loadSummary).mockRejectedValue(new Error('offline'));
    vi.mocked(sources.loadActivities).mockResolvedValue([{
      id: 'a1',
      action: 'document.uploaded',
      resourceType: 'document',
      resourceId: 'd1',
      resourceName: 'handbook.pdf',
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: '员工手册',
      createdAt: '2026-07-02T00:00:00Z',
    }]);
    renderWithRouter(<HomePage sources={sources} />);

    expect(await screen.findByRole('link', { name: /handbook\.pdf/ })).toBeInTheDocument();
  });

  it('finishes loading when mounted under React Strict Mode', async () => {
    const sources = createSources();
    const summary = deferred<Awaited<ReturnType<HomeSources['loadSummary']>>>();
    sources.loadSummary = vi.fn(() => summary.promise);

    render(
      <StrictMode>
        <ToastProvider>
          <MemoryRouter initialEntries={['/home']}>
            <HomePage sources={sources} />
          </MemoryRouter>
        </ToastProvider>
      </StrictMode>,
    );
    await act(async () => summary.resolve(createSummary({
      stats: {
        ...createSummary().stats,
        knowledgeBases: { value: 7, changeRatio: 0 },
      },
    })));

    expect(await screen.findByText('个知识库')).toHaveTextContent('个知识库');
    expect(screen.getByText('个知识库').parentElement).toHaveTextContent('7个知识库');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('retries the summary after a failure', async () => {
    const sources = createSources();
    vi.mocked(sources.loadSummary).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(createSummary({
      stats: {
        ...createSummary().stats,
        knowledgeBases: { value: 7, changeRatio: 0 },
      },
    }));
    const user = userEvent.setup();
    renderWithRouter(<HomePage sources={sources} />);
    const unavailable = await screen.findByText('统计暂不可用');

    await user.click(within(unavailable.parentElement!).getByRole('button', { name: '重试' }));
    await screen.findByText('个知识库');
    expect(screen.getByText('个知识库').parentElement).toHaveTextContent('7个知识库');
    expect(vi.mocked(sources.loadSummary).mock.calls.length).toBeGreaterThan(1);
  });

  it('shows and retries an activity loading failure instead of an empty state', async () => {
    const sources = createSources();
    vi.mocked(sources.loadActivities)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithRouter(<HomePage sources={sources} />);

    const unavailable = await screen.findByText('动态暂不可用');
    expect(screen.queryByText('还没有动态')).not.toBeInTheDocument();

    await user.click(within(unavailable.parentElement!).getByRole('button', { name: '重试' }));

    expect(await screen.findByText('还没有动态')).toBeInTheDocument();
    expect(sources.loadActivities).toHaveBeenCalledTimes(2);
  });
});
