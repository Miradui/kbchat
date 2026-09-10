import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import type { KnowledgeBase, KnowledgeBaseDetailStatsResponse } from '../../types/api';
import { KnowledgeBaseOverviewPage } from './KnowledgeBaseOverviewPage';

const resources = vi.hoisted(() => ({
  getKnowledgeBase: vi.fn(), recordKnowledgeBaseView: vi.fn(),
  getKnowledgeBaseDetailStats: vi.fn(), listDocuments: vi.fn(), listKnowledgeBaseCategories: vi.fn(),
}));
vi.mock('../../api/resources', () => resources);
vi.mock('../../layouts/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock('./KnowledgeBaseLayout', () => ({
  KnowledgeBaseLayout: ({ children, knowledgeBase }: { children: ReactNode; knowledgeBase: KnowledgeBase }) => <main><h1>{knowledgeBase.name}</h1>{children}</main>,
  KnowledgeBaseLoadFailure: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function stats(value: number, period: 'day' | 'month' = 'month'): KnowledgeBaseDetailStatsResponse {
  return { knowledgeBaseId: 'kb1', period, documents: { value: 0, changeRatio: null }, views: { value, changeRatio: null }, questions: { value: 0, changeRatio: null } };
}

const emptyDocuments = { items: [], total: 0, page: 1, pageSize: 6 };
const knowledgeBase: KnowledgeBase = {
  id: 'kb1', name: '知识库一', description: '', visibility: 'private',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

function renderOverview() {
  return renderWithRouter(<>
    <Link to="/knowledge-bases/kb2">切换知识库</Link>
    <Routes><Route path="/knowledge-bases/:id" element={<KnowledgeBaseOverviewPage />} /></Routes>
  </>, ['/knowledge-bases/kb1']);
}

beforeEach(() => {
  vi.resetAllMocks();
  resources.getKnowledgeBase.mockImplementation(async (id: string) => ({ ...knowledgeBase, id, name: id === 'kb1' ? '知识库一' : '知识库二' }));
  resources.recordKnowledgeBaseView.mockResolvedValue(undefined);
  resources.getKnowledgeBaseDetailStats.mockResolvedValue(stats(222));
  resources.listDocuments.mockResolvedValue(emptyDocuments);
  resources.listKnowledgeBaseCategories.mockResolvedValue({ items: [] });
});

describe('KnowledgeBaseOverviewPage', () => {
  it.each(['success', 'failure'] as const)('ignores a late day %s after returning to month', async (outcome) => {
    const user = userEvent.setup();
    const day = deferred<KnowledgeBaseDetailStatsResponse>();
    resources.getKnowledgeBaseDetailStats.mockImplementation((_id, period) => period === 'day' ? day.promise : Promise.resolve(stats(222)));
    renderOverview();
    await screen.findByText('222');
    await user.click(screen.getByRole('button', { name: '日', exact: true }));
    expect(screen.queryByText('222')).not.toBeInTheDocument();
    expect(screen.getByText('正在加载统计…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '月', exact: true }));
    await screen.findByText('222');
    await act(async () => {
      if (outcome === 'success') day.resolve(stats(111, 'day'));
      else day.reject(new Error('过期统计失败'));
    });
    expect(screen.getByRole('button', { name: '月', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('222')).toBeInTheDocument();
    expect(screen.queryByText('111')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers retry without presenting failed document reads as an empty library', async () => {
    const user = userEvent.setup();
    resources.listDocuments.mockRejectedValue(new Error('文档服务暂不可用'));
    renderOverview();
    expect(await screen.findByRole('alert')).toHaveTextContent('文档摘要加载失败');
    expect(screen.queryByRole('heading', { name: '还没有文档' })).not.toBeInTheDocument();
    resources.listDocuments.mockResolvedValue(emptyDocuments);
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('heading', { name: '还没有文档' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the previous library immediately and ignores its pending summaries', async () => {
    const user = userEvent.setup();
    const nextKB = deferred<KnowledgeBase>();
    const previousStats = deferred<KnowledgeBaseDetailStatsResponse>();
    const previousDocuments = deferred<typeof emptyDocuments>();
    resources.getKnowledgeBase.mockImplementation((id) => id === 'kb2' ? nextKB.promise : Promise.resolve(knowledgeBase));
    resources.getKnowledgeBaseDetailStats.mockImplementation((id) => id === 'kb1' ? previousStats.promise : Promise.resolve(stats(333)));
    resources.listDocuments.mockImplementation((id) => id === 'kb1' ? previousDocuments.promise : Promise.resolve(emptyDocuments));
    renderOverview();
    await screen.findByRole('heading', { name: '知识库一' });
    await user.click(screen.getByRole('link', { name: '切换知识库' }));
    expect(screen.queryByRole('heading', { name: '知识库一' })).not.toBeInTheDocument();
    await act(async () => nextKB.resolve({ ...knowledgeBase, id: 'kb2', name: '知识库二' }));
    await screen.findByText('333');
    await act(async () => {
      previousStats.resolve(stats(111));
      previousDocuments.reject(new Error('旧知识库读取失败'));
    });
    expect(screen.getByRole('heading', { name: '知识库二' })).toBeInTheDocument();
    expect(screen.getByText('333')).toBeInTheDocument();
    expect(screen.queryByText('111')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
