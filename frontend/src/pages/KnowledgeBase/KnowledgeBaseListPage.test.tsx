import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import { KnowledgeBaseListPage } from './KnowledgeBaseListPage';

const api = vi.hoisted(() => ({
  batchDeleteKnowledgeBases: vi.fn(),
  batchFavoriteKnowledgeBases: vi.fn(),
  batchMoveKnowledgeBases: vi.fn(),
  batchRestoreKnowledgeBases: vi.fn(),
  createKnowledgeBase: vi.fn(),
  createKnowledgeBaseCategory: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  deleteKnowledgeBaseCategory: vi.fn(),
  deleteKnowledgeBasePermanently: vi.fn(),
  emptyKnowledgeBaseRecycleBin: vi.fn(),
  favoriteKnowledgeBase: vi.fn(),
  getCurrentUser: vi.fn(),
  getKnowledgeBaseStats: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBaseRecycleBin: vi.fn(),
  listKnowledgeBases: vi.fn(),
  listKnowledgeBaseTags: vi.fn(),
  logout: vi.fn(),
  recordKnowledgeBaseView: vi.fn(),
  reorderKnowledgeBaseCategories: vi.fn(),
  restoreKnowledgeBase: vi.fn(),
  unfavoriteKnowledgeBase: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  updateKnowledgeBaseCategory: vi.fn(),
  updateWorkspacePreference: vi.fn(),
}));

vi.mock('../../api/resources', () => api);

const existingKnowledgeBase = {
  id: 'kb-1',
  name: '现有知识库',
  description: '已加载的数据',
  visibility: 'private' as const,
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

const stats = {
  period: 'month' as const,
  knowledgeBases: { value: 1, changeRatio: 0 },
  documents: { value: 0, changeRatio: 0 },
  views: { value: 0, changeRatio: 0 },
  questions: { value: 0, changeRatio: 0 },
};

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.getCurrentUser.mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员' });
  api.getWorkspacePreference.mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
  api.listKnowledgeBaseCategories.mockResolvedValue({ items: [] });
  api.listKnowledgeBaseTags.mockResolvedValue({ items: [] });
  api.getKnowledgeBaseStats.mockResolvedValue(stats);
  api.listKnowledgeBaseRecycleBin.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  api.listKnowledgeBases.mockResolvedValue({ items: [existingKnowledgeBase], total: 1, page: 1, pageSize: 10 });
  api.createKnowledgeBase.mockResolvedValue({ ...existingKnowledgeBase, id: 'kb-2', name: '新知识库' });
});

describe('KnowledgeBaseListPage mutation refresh', () => {
  it('reports a successful create separately from a following list refresh failure', async () => {
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);
    expect(await screen.findByText('现有知识库')).toBeInTheDocument();

    api.listKnowledgeBases.mockRejectedValueOnce(new Error('refresh failed'));
    await user.click(screen.getByRole('button', { name: '+ 新建知识库' }));
    await user.type(screen.getByLabelText('名称'), '新知识库');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('操作已成功，但页面数据刷新失败。无需重复提交，请刷新页面查看最新结果。')).toBeInTheDocument();
    expect(screen.getByText('现有知识库')).toBeInTheDocument();
    expect(api.createKnowledgeBase).toHaveBeenCalledOnce();
  });
});
