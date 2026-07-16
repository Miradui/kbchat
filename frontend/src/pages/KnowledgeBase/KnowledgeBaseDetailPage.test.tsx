import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';

import { renderWithRouter } from '../../test/render';
import { KnowledgeBaseDetailPage } from './KnowledgeBaseDetailPage';

const api = vi.hoisted(() => ({
  addKnowledgeBaseMember: vi.fn(),
  createChatSession: vi.fn(),
  deleteKnowledgeBaseMember: vi.fn(),
  getKnowledgeBase: vi.fn(),
  getKnowledgeBasePermissions: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listDocuments: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  recordKnowledgeBaseView: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  searchUsers: vi.fn(),
  updateKnowledgeBaseMember: vi.fn(),
  updateKnowledgeBasePermissions: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../api/resources', () => api);

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.getKnowledgeBase.mockResolvedValue({
    id: 'kb-1', name: '员工制度', description: '制度文档', visibility: 'private',
    retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  });
  api.listDocuments.mockResolvedValue({ items: [] });
  api.listKnowledgeBaseCategories.mockResolvedValue({ items: [] });
  api.getKnowledgeBasePermissions.mockResolvedValue({ owner: null, managers: [], members: [], visibility: 'private' });
  api.getWorkspacePreference.mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
  api.recordKnowledgeBaseView.mockResolvedValue(undefined);
});

describe('KnowledgeBaseDetailPage retrieval debug', () => {
  it('requests and progressively displays vector, rerank, and final stages', async () => {
    api.searchKnowledgeBase.mockResolvedValue({
      items: [],
      rerankFallback: { used: true, reason: 'provider_unavailable' },
      debug: {
        query: '报销',
        vectorStage: { status: 'completed', items: [{ chunkId: 'c1', documentId: 'd1', filename: 'policy.md', content: '向量内容', pageNumber: null, vectorScore: 0.8, rank: 1 }] },
        rerankStage: { status: 'fallback', input: [{ chunkId: 'c1', rank: 1 }], output: [] },
        finalStage: { items: [{ chunkId: 'c1', vectorScore: 0.8, rerankScore: null, rank: 1 }] },
        rerankFallback: { used: true, reason: 'provider_unavailable' },
      },
    });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>,
      ['/knowledge-bases/kb-1'],
    );

    await screen.findByRole('heading', { name: '员工制度' });
    await user.type(screen.getByLabelText('知识库内检索问题'), '报销');
    await user.click(screen.getByLabelText('显示检索调试信息'));
    await user.click(screen.getByRole('button', { name: '检索' }));

    expect(api.searchKnowledgeBase).toHaveBeenCalledWith('kb-1', expect.objectContaining({ debug: true }));
    expect(await screen.findByText('向量召回')).toBeInTheDocument();
    expect(screen.getByText('Rerank 阶段')).toBeInTheDocument();
    expect(screen.getByText('最终结果')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Rerank 服务暂不可用');
    expect(screen.queryByText('provider_unavailable')).not.toBeInTheDocument();
  });

  it('ignores an older semantic-search response that resolves last', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    api.searchKnowledgeBase.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    renderWithRouter(
      <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>,
      ['/knowledge-bases/kb-1'],
    );

    await screen.findByRole('heading', { name: '员工制度' });
    const input = screen.getByLabelText('知识库内检索问题');
    const form = input.closest('form');
    if (!form) throw new Error('semantic search form not found');

    await user.type(input, '旧问题');
    fireEvent.submit(form);
    await user.clear(input);
    await user.type(input, '新问题');
    fireEvent.submit(form);

    await act(async () => second.resolve(searchResponse('新结果')));
    expect(await screen.findByText('新结果')).toBeInTheDocument();
    await act(async () => first.resolve(searchResponse('旧结果')));

    expect(screen.getByText('新结果')).toBeInTheDocument();
    expect(screen.queryByText('旧结果')).not.toBeInTheDocument();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function searchResponse(content: string) {
  return {
    items: [{
      chunkId: content,
      documentId: 'd1',
      filename: 'policy.md',
      content,
      pageNumber: null,
      vectorScore: 0.8,
      rerankScore: 0.9,
    }],
    rerankFallback: null,
  };
}
