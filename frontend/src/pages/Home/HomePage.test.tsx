import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../components/feedback/ToastProvider';
import { renderWithRouter } from '../../test/render';
import type { GlobalDocumentItem, KnowledgeBase } from '../../types/api';
import type { HomeSources } from './homeData';
import { HomePage } from './HomePage';

const knowledgeBase = { id: 'kb1', name: '员工手册', description: '制度资料', visibility: 'private', retrievalConfig: { vectorTopN: 20, rerankTopK: 5, scoreThreshold: 0.2, enableRerank: true }, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z' } satisfies KnowledgeBase;
const document = { id: 'd1', knowledgeBaseId: 'kb1', knowledgeBaseName: '员工手册', filename: 'handbook.pdf', fileType: 'pdf', fileSize: 120, status: 'completed', errorMessage: null, createdAt: '2026-07-02T00:00:00Z' } satisfies GlobalDocumentItem;

function createSources(): HomeSources {
  return {
    loadStats: vi.fn().mockResolvedValue({ period: 'month', knowledgeBases: { value: 1, changeRatio: 0 }, documents: { value: 1, changeRatio: 0 }, views: { value: 0, changeRatio: 0 }, questions: { value: 0, changeRatio: 0 } }),
    loadKnowledgeBases: vi.fn().mockResolvedValue({ items: [knowledgeBase], total: 1, page: 1, pageSize: 5 }),
    loadDocuments: vi.fn().mockResolvedValue({ items: [document], total: 1, page: 1, pageSize: 5 }),
    loadSessions: vi.fn().mockResolvedValue({ items: [] }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('HomePage', () => {
  it('links the primary knowledge-base action to the create intent', async () => {
    renderWithRouter(<HomePage sources={createSources()} />);

    expect(await screen.findByRole('link', { name: /新建知识库/ })).toHaveAttribute(
      'href',
      '/knowledge-bases?intent=create',
    );
  });

  it('links document activity directly to the document detail', async () => {
    renderWithRouter(<HomePage sources={createSources()} />);

    expect(await screen.findByRole('link', { name: /handbook\.pdf/ })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb1/documents?documentId=d1',
    );
  });

  it('keeps successful regions visible beside a failed document region', async () => {
    const sources = createSources();
    vi.mocked(sources.loadDocuments).mockRejectedValue(new Error('offline'));
    renderWithRouter(<HomePage sources={sources} />);

    expect(await screen.findByText('员工手册')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('文档动态加载失败');
    expect(screen.queryByText('暂无失败任务')).not.toBeInTheDocument();
  });

  it('finishes loading when mounted under React Strict Mode', async () => {
    const sources = createSources();
    const knowledgeBases = deferred<Awaited<ReturnType<HomeSources['loadKnowledgeBases']>>>();
    sources.loadKnowledgeBases = vi.fn(() => knowledgeBases.promise);

    render(
      <StrictMode>
        <ToastProvider>
          <MemoryRouter initialEntries={['/home']}>
            <HomePage sources={sources} />
          </MemoryRouter>
        </ToastProvider>
      </StrictMode>,
    );
    await act(async () => knowledgeBases.resolve({
      items: [{ ...knowledgeBase, name: '严格模式知识库' }],
      total: 1,
      page: 1,
      pageSize: 5,
    }));

    expect(await screen.findByText('严格模式知识库')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('retries only the failed region without hiding successful content', async () => {
    const sources = createSources();
    vi.mocked(sources.loadDocuments).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [document], total: 1, page: 1, pageSize: 5 });
    const user = userEvent.setup();
    renderWithRouter(<HomePage sources={sources} />);
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByText('员工手册')).toBeInTheDocument();
    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();
    expect(sources.loadDocuments).toHaveBeenCalledTimes(2);
    expect(sources.loadStats).toHaveBeenCalledOnce();
    expect(sources.loadKnowledgeBases).toHaveBeenCalledOnce();
    expect(sources.loadSessions).toHaveBeenCalledOnce();
  });
});
