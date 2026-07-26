import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import {
  batchFavoriteKnowledgeBases,
  batchMoveKnowledgeBases,
  createKnowledgeBase,
  createKnowledgeBaseCategory,
  deleteKnowledgeBase,
  favoriteKnowledgeBase,
  getKnowledgeBaseStats,
  getWorkspacePreference,
  listKnowledgeBaseCategories,
  listKnowledgeBaseRecycleBin,
  listKnowledgeBases,
  listKnowledgeBaseTags,
  reorderKnowledgeBaseCategories,
  restoreKnowledgeBase,
  updateKnowledgeBase,
  updateWorkspacePreference,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { KnowledgeBase } from '../../types/api';
import { KnowledgeBaseListPage } from './KnowledgeBaseListPage';

async function chooseKnowledgeBaseAction(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  knowledgeBaseName: string,
  action: '编辑' | '移动到分类' | '删除',
) {
  await user.click(within(container).getByRole('button', {
    name: `${knowledgeBaseName}的更多操作`,
  }));
  await user.click(screen.getByRole('menuitem', { name: action }));
}

vi.mock('../../api/resources', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/resources')>(),
  batchFavoriteKnowledgeBases: vi.fn(),
  batchMoveKnowledgeBases: vi.fn(),
  createKnowledgeBase: vi.fn(),
  createKnowledgeBaseCategory: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  favoriteKnowledgeBase: vi.fn(),
  getKnowledgeBaseStats: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBaseRecycleBin: vi.fn(),
  listKnowledgeBases: vi.fn(),
  listKnowledgeBaseTags: vi.fn(),
  reorderKnowledgeBaseCategories: vi.fn(),
  restoreKnowledgeBase: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  updateWorkspacePreference: vi.fn(),
}));

const createdKnowledgeBase = {
  id: 'kb-new',
  name: '新知识库',
  description: '',
  visibility: 'private',
  retrievalConfig: {
    vectorTopN: 30,
    rerankTopK: 5,
    scoreThreshold: 0.3,
    enableRerank: true,
  },
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBase;

const secondKnowledgeBase = {
  ...createdKnowledgeBase,
  id: 'kb-second',
  name: '最新筛选结果',
} satisfies KnowledgeBase;

const knowledgeBaseTags = [
  {
    id: 'tag-a',
    name: '制度',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  },
  {
    id: 'tag-b',
    name: '人事',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  },
  {
    id: 'tag-c',
    name: '财务',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  },
];

const categories = [
  {
    id: 'category-a',
    parentId: null,
    name: '制度分类',
    sortOrder: 10,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  },
  {
    id: 'category-b',
    parentId: null,
    name: '产品分类',
    sortOrder: 20,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  },
];

const nestedCategories = [
  {
    ...categories[0],
    children: [{
      ...categories[0],
      id: 'category-child',
      parentId: categories[0].id,
      name: '制度子分类',
      sortOrder: 10,
    }],
  },
  categories[1],
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.mocked(batchFavoriteKnowledgeBases).mockReset().mockResolvedValue({ processedCount: 0 });
  vi.mocked(batchMoveKnowledgeBases).mockReset().mockResolvedValue({ processedCount: 1 });
  vi.mocked(deleteKnowledgeBase).mockReset().mockResolvedValue(undefined);
  vi.mocked(favoriteKnowledgeBase).mockReset();
  vi.mocked(createKnowledgeBase).mockReset().mockResolvedValue(createdKnowledgeBase);
  vi.mocked(createKnowledgeBaseCategory).mockReset().mockResolvedValue(categories[0]);
  vi.mocked(getWorkspacePreference).mockReset().mockResolvedValue({
    viewMode: 'table',
    scope: 'all',
    sort: 'updatedAt_desc',
    visibility: 'all',
    expandedCategoryIds: [],
  });
  vi.mocked(listKnowledgeBaseCategories).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(listKnowledgeBaseTags).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(reorderKnowledgeBaseCategories).mockReset();
  vi.mocked(getKnowledgeBaseStats).mockReset().mockResolvedValue({
    period: 'month',
    knowledgeBases: { value: 0, changeRatio: 0 },
    documents: { value: 0, changeRatio: 0 },
    views: { value: 0, changeRatio: 0 },
    questions: { value: 0, changeRatio: 0 },
  });
  vi.mocked(listKnowledgeBaseRecycleBin).mockReset().mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  vi.mocked(listKnowledgeBases).mockReset().mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
  });
  vi.mocked(restoreKnowledgeBase).mockReset().mockResolvedValue(undefined);
  vi.mocked(updateKnowledgeBase).mockReset().mockImplementation(async (_, input) => ({
    ...createdKnowledgeBase,
    name: input.name,
    description: input.description,
    tags: knowledgeBaseTags.filter((tag) => input.tagIds?.includes(tag.id)),
  }));
  vi.mocked(updateWorkspacePreference).mockReset().mockImplementation(async (preference) => preference);
});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}{location.search}</output>;
}

describe('KnowledgeBaseListPage', () => {
  it('keeps tag administration discoverable from the knowledge-base context', async () => {
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    expect(await screen.findByRole('link', { name: '管理标签' })).toHaveAttribute('href', '/tags');
  });

  it('keeps statistics unknown when loading fails and retries statistics independently', async () => {
    vi.mocked(getKnowledgeBaseStats)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        period: 'month',
        knowledgeBases: { value: 2, changeRatio: 0 },
        documents: { value: 8, changeRatio: 0 },
        views: { value: 12, changeRatio: 0 },
        questions: { value: 5, changeRatio: 0 },
      });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('知识库统计加载失败');
    const documentMetric = screen.getByText('文档总数').parentElement!;
    expect(within(documentMetric).getByText('--')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: '重试统计' }));

    await waitFor(() => expect(getKnowledgeBaseStats).toHaveBeenCalledTimes(2));
    expect(within(documentMetric).getByText('8')).toBeInTheDocument();
    expect(listKnowledgeBases).toHaveBeenCalledTimes(1);
  });

  it('shows a retry instead of an empty state when the knowledge-base list fails', async () => {
    vi.mocked(listKnowledgeBases)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 10 });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('知识库加载失败');
    expect(screen.queryByText(/当前筛选下没有知识库/)).not.toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: '重试知识库列表' }));

    expect(await screen.findByText(/当前筛选下没有知识库/)).toBeInTheDocument();
    expect(listKnowledgeBases).toHaveBeenCalledTimes(2);
  });

  it('offers initialization recovery without also showing the normal empty state', async () => {
    vi.mocked(listKnowledgeBaseCategories)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [] });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('工作台初始化失败');
    expect(screen.queryByText(/当前筛选下没有知识库/)).not.toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: '重试初始化' }));

    await waitFor(() => expect(listKnowledgeBaseCategories).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/当前筛选下没有知识库/)).toBeInTheDocument();
  });

  it('keeps a mutation refresh newer than an overlapping bootstrap retry', async () => {
    const bootstrapRetry = deferred<{ items: typeof categories }>();
    const mutationReload = deferred<{ items: typeof categories }>();
    const latestCategories = [{ ...categories[0], id: 'category-latest', name: '最新分类' }];
    vi.mocked(listKnowledgeBaseCategories)
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(bootstrapRetry.promise)
      .mockReturnValueOnce(mutationReload.promise);
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: '重试初始化' }));
    await user.click(screen.getByRole('button', { name: '新增根分类' }));
    const dialog = screen.getByRole('dialog', { name: '新建分类' });
    expect(dialog).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: '分类名称' }), '最新分类');
    await user.click(within(dialog).getByRole('button', { name: '保存分类' }));
    await waitFor(() => expect(listKnowledgeBaseCategories).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('dialog', { name: '新建分类' })).not.toBeInTheDocument();

    await act(async () => mutationReload.resolve({ items: latestCategories }));
    expect(await screen.findByRole('button', { name: '最新分类' })).toBeInTheDocument();

    await act(async () => bootstrapRetry.resolve({ items: categories }));
    expect(screen.getByRole('button', { name: '最新分类' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '制度分类' })).not.toBeInTheDocument();
  });

  it('keeps the category dialog open with its input after saving fails', async () => {
    vi.mocked(createKnowledgeBaseCategory).mockRejectedValueOnce(new ApiError(409, {
      code: 'CATEGORY_EXISTS',
      message: '分类名称已存在',
    }));
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    await user.click(await screen.findByRole('button', { name: '新增根分类' }));
    const dialog = screen.getByRole('dialog', { name: '新建分类' });
    const input = within(dialog).getByRole('textbox', { name: '分类名称' });
    await user.type(input, '制度分类');
    await user.click(within(dialog).getByRole('button', { name: '保存分类' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('分类名称已存在');
    expect(input).toHaveValue('制度分类');
    expect(screen.getByRole('dialog', { name: '新建分类' })).toBeInTheDocument();
  });

  it('keeps the recycle-bin count unknown when its initial request fails', async () => {
    vi.mocked(listKnowledgeBaseRecycleBin).mockRejectedValue(new Error('offline'));
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    expect(await screen.findByRole('button', { name: '回收站 --' })).toBeInTheDocument();
  });

  it('shows omitted per-knowledge-base counters as unknown in table and card views', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [createdKnowledgeBase], total: 1, page: 1, pageSize: 10,
    });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const row = await screen.findByRole('row', { name: /新知识库/ });
    expect(within(row).getByText('--')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '卡片视图' }));

    expect(await screen.findByText('-- 文档')).toBeInTheDocument();
    expect(screen.getByText('-- 浏览')).toBeInTheDocument();
    expect(screen.getByText('-- 问答')).toBeInTheDocument();
  });

  it('locks every row action while a favorite mutation is in progress', async () => {
    const favoriteResult = deferred<void>();
    vi.mocked(favoriteKnowledgeBase).mockReturnValue(favoriteResult.promise);
    vi.mocked(listKnowledgeBaseCategories).mockResolvedValue({ items: categories });
    vi.mocked(listKnowledgeBases)
      .mockResolvedValueOnce({ items: [createdKnowledgeBase, secondKnowledgeBase], total: 2, page: 1, pageSize: 10 })
      .mockResolvedValueOnce({
        items: [{ ...createdKnowledgeBase, isFavorite: true }, secondKnowledgeBase], total: 2, page: 1, pageSize: 10,
      });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const firstRow = await screen.findByRole('row', { name: /新知识库/ });
    const secondRow = screen.getByRole('row', { name: /最新筛选结果/ });
    await user.click(within(firstRow).getByRole('checkbox', { name: '选择 新知识库' }));
    await user.click(within(firstRow).getByRole('button', { name: '收藏' }));
    expect(within(firstRow).getByRole('button', { name: '新知识库的更多操作' })).toBeDisabled();
    expect(within(secondRow).getByRole('button', { name: '收藏' })).toBeDisabled();
    expect(within(secondRow).getByRole('button', { name: '最新筛选结果的更多操作' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '批量收藏' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消收藏' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新增根分类' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '编辑 制度分类' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 制度分类' })).toBeDisabled();

    favoriteResult.resolve();
    await waitFor(() => expect(
      within(screen.getByRole('row', { name: /新知识库/ })).getByRole('button', { name: '取消收藏' }),
    ).toBeEnabled());
  });

  it('locks row actions while a batch favorite mutation is in progress', async () => {
    const favoriteResult = deferred<{ processedCount: number }>();
    vi.mocked(batchFavoriteKnowledgeBases).mockReturnValue(favoriteResult.promise);
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [createdKnowledgeBase], total: 1, page: 1, pageSize: 10,
    });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const row = await screen.findByRole('row', { name: /新知识库/ });
    await user.click(within(row).getByRole('checkbox', { name: '选择 新知识库' }));
    await user.click(screen.getByRole('button', { name: '批量收藏' }));

    expect(within(row).getByRole('button', { name: '收藏' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: '新知识库的更多操作' })).toBeDisabled();

    favoriteResult.resolve({ processedCount: 1 });
    await waitFor(() => expect(within(row).getByRole('button', { name: '收藏' })).toBeEnabled());
  });

  it('locks knowledge-base actions and blocks cross-operation reentry while sorting categories', async () => {
    const reorderResult = deferred<{ processedCount: number }>();
    vi.mocked(reorderKnowledgeBaseCategories).mockReturnValue(reorderResult.promise);
    vi.mocked(listKnowledgeBaseCategories).mockResolvedValue({ items: categories });
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [createdKnowledgeBase], total: 1, page: 1, pageSize: 10,
    });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const moveButton = await screen.findByRole('button', { name: '制度分类 下移' });
    const row = await screen.findByRole('row', { name: /新知识库/ });
    const favoriteButton = within(row).getByRole('button', { name: '收藏' });
    act(() => {
      moveButton.click();
      favoriteButton.click();
    });

    expect(reorderKnowledgeBaseCategories).toHaveBeenCalledOnce();
    expect(favoriteKnowledgeBase).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '新增根分类' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '编辑 制度分类' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 制度分类' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新建知识库' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '回收站 0' })).toBeDisabled();
    expect(favoriteButton).toBeDisabled();

    reorderResult.resolve({ processedCount: 2 });
    await waitFor(() => expect(favoriteButton).toBeEnabled());
  });

  it('locks category navigation and announces the affected workspace during a mutation', async () => {
    const favoriteResult = deferred<void>();
    vi.mocked(favoriteKnowledgeBase).mockReturnValue(favoriteResult.promise);
    vi.mocked(listKnowledgeBaseCategories).mockResolvedValue({ items: nestedCategories });
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [createdKnowledgeBase], total: 1, page: 1, pageSize: 10,
    });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const favoriteButton = await screen.findByRole('button', { name: '收藏' });
    await user.click(favoriteButton);

    const workspace = screen.getByRole('region', { name: '知识库工作区' });
    const categoryRegion = screen.getByRole('region', { name: '知识库分类' });
    const expandButton = screen.getByRole('button', { name: '展开 制度分类' });
    const categoryButton = screen.getByRole('button', { name: '制度分类' });
    expect(workspace).toHaveAttribute('aria-busy', 'true');
    expect(categoryRegion).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status', { name: '正在处理工作区操作' })).toBeInTheDocument();
    expect(expandButton).toBeDisabled();
    expect(categoryButton).toBeDisabled();

    expandButton.click();
    categoryButton.click();
    expect(updateWorkspacePreference).not.toHaveBeenCalled();
    expect(listKnowledgeBases).toHaveBeenCalledTimes(1);

    favoriteResult.resolve();
    await waitFor(() => expect(workspace).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByRole('status', { name: '正在处理工作区操作' })).not.toBeInTheDocument();
    expect(expandButton).toBeEnabled();
    expect(categoryButton).toBeEnabled();
  });

  it('blocks category sorting when a favorite mutation starts in the same tick', async () => {
    const favoriteResult = deferred<void>();
    vi.mocked(favoriteKnowledgeBase).mockReturnValue(favoriteResult.promise);
    vi.mocked(listKnowledgeBaseCategories).mockResolvedValue({ items: categories });
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [createdKnowledgeBase], total: 1, page: 1, pageSize: 10,
    });
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const favoriteButton = await screen.findByRole('button', { name: '收藏' });
    const moveButton = screen.getByRole('button', { name: '制度分类 下移' });
    act(() => {
      favoriteButton.click();
      moveButton.click();
    });

    expect(favoriteKnowledgeBase).toHaveBeenCalledOnce();
    expect(reorderKnowledgeBaseCategories).not.toHaveBeenCalled();

    favoriteResult.resolve();
    await waitFor(() => expect(moveButton).toBeEnabled());
  });

  it('synchronously blocks resource mutations while a preference save is pending', async () => {
    const preferenceResult = deferred<ReturnType<typeof preferenceValue>>();
    vi.mocked(updateWorkspacePreference).mockReturnValue(preferenceResult.promise);
    vi.mocked(listKnowledgeBaseCategories).mockResolvedValue({ items: categories });
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [createdKnowledgeBase], total: 1, page: 1, pageSize: 10,
    });
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const cardButton = await screen.findByRole('button', { name: '卡片视图' });
    const row = await screen.findByRole('row', { name: /新知识库/ });
    const favoriteButton = within(row).getByRole('button', { name: '收藏' });
    act(() => {
      cardButton.click();
      favoriteButton.click();
    });

    expect(updateWorkspacePreference).toHaveBeenCalledOnce();
    expect(favoriteKnowledgeBase).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: '知识库工作区' })).toHaveAttribute('aria-busy', 'true');

    preferenceResult.resolve(preferenceValue('card'));
    await waitFor(() => expect(favoriteButton).toBeEnabled());
  });

  it('blocks preference changes when a resource mutation starts in the same tick', async () => {
    const favoriteResult = deferred<void>();
    vi.mocked(favoriteKnowledgeBase).mockReturnValue(favoriteResult.promise);
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [createdKnowledgeBase], total: 1, page: 1, pageSize: 10,
    });
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const row = await screen.findByRole('row', { name: /新知识库/ });
    const favoriteButton = within(row).getByRole('button', { name: '收藏' });
    const cardButton = screen.getByRole('button', { name: '卡片视图' });
    act(() => {
      favoriteButton.click();
      cardButton.click();
    });

    expect(favoriteKnowledgeBase).toHaveBeenCalledOnce();
    expect(updateWorkspacePreference).not.toHaveBeenCalled();
    expect(cardButton).toHaveAttribute('aria-pressed', 'false');

    favoriteResult.resolve();
    await waitFor(() => expect(cardButton).toBeEnabled());
  });

  it('exposes category and scope selection semantics with keyboard navigation', async () => {
    vi.mocked(listKnowledgeBaseCategories).mockResolvedValue({ items: categories });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const categoryButton = await screen.findByRole('button', { name: '制度分类' });
    expect(categoryButton).not.toHaveAttribute('aria-current');
    await user.click(categoryButton);
    expect(categoryButton).toHaveAttribute('aria-current', 'true');

    const allTab = screen.getByRole('tab', { name: '全部' });
    const mineTab = screen.getByRole('tab', { name: '我创建的' });
    expect(allTab).toHaveAttribute('aria-selected', 'true');
    expect(allTab).toHaveAttribute('tabindex', '0');
    expect(mineTab).toHaveAttribute('aria-selected', 'false');
    expect(mineTab).toHaveAttribute('tabindex', '-1');
    const allPanel = screen.getByRole('tabpanel', { name: '全部' });
    expect(allTab).toHaveAttribute('aria-controls', allPanel.id);

    allTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(mineTab).toHaveFocus();
    expect(mineTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '我创建的' })).toBe(allPanel);
  });

  it('announces the primary list loading state', () => {
    vi.mocked(listKnowledgeBases).mockReturnValue(deferred<Awaited<ReturnType<typeof listKnowledgeBases>>>().promise);
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    expect(screen.getByRole('status', { name: '正在加载' })).toBeInTheDocument();
  });

  it('opens the create modal from the URL intent', async () => {
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases" element={<KnowledgeBaseListPage />} />
      </Routes>,
      ['/knowledge-bases?intent=create'],
    );

    const dialog = await screen.findByRole('dialog', { name: '新建知识库' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('dialog-backdrop')).toContainElement(dialog);
  });

  it('prioritizes basic fields and keeps optional settings collapsed by default', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases" element={<KnowledgeBaseListPage />} />
      </Routes>,
      ['/knowledge-bases?intent=create'],
    );

    const dialog = await screen.findByRole('dialog', { name: '新建知识库' });
    const name = within(dialog).getByRole('textbox', { name: '名称' });
    const description = within(dialog).getByRole('textbox', { name: '描述' });
    expect(name.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(name).toHaveValue('');
    expect(description).toHaveValue('');

    const advanced = within(dialog).getByText('更多设置').closest('details');
    expect(advanced).not.toHaveAttribute('open');
    await user.click(within(dialog).getByText('更多设置'));
    expect(within(dialog).getByRole('combobox', { name: '分类' })).toHaveValue('');
    expect(within(dialog).getByRole('group', { name: '标签' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: '访问权限' })).toHaveValue('private');
  });

  it('keeps optional settings expanded when editing a knowledge base', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [createdKnowledgeBase],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const row = (await screen.findByRole('link', { name: /新知识库/ })).closest('tr')!;
    await chooseKnowledgeBaseAction(user, row, '新知识库', '编辑');

    const dialog = screen.getByRole('dialog', { name: '编辑知识库' });
    const advanced = within(dialog).getByText('更多设置').closest('details');
    expect(advanced).toHaveAttribute('open');
    expect(within(dialog).getByRole('combobox', { name: '分类' })).toBeVisible();
  });

  it('continues to document upload after creating a knowledge base', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/knowledge-bases" element={<KnowledgeBaseListPage />} />
          <Route path="/knowledge-bases/:id/documents" element={<div>文档页</div>} />
        </Routes>
        <LocationProbe />
      </>,
      ['/knowledge-bases?intent=create'],
    );

    await user.type(await screen.findByRole('textbox', { name: '名称' }), '新知识库');
    await user.click(screen.getByRole('button', { name: '创建并导入文档' }));

    await waitFor(() => expect(createKnowledgeBase).toHaveBeenCalledOnce());
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent(
      '/knowledge-bases/kb-new/documents?intent=upload',
    );
  });

  it('constrains focus in the create modal and closes a pristine form with Escape', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases" element={<KnowledgeBaseListPage />} />
      </Routes>,
      ['/knowledge-bases?intent=create'],
    );

    const nameInput = await screen.findByRole('textbox', { name: '名称' });
    await waitFor(() => expect(nameInput).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '新建知识库' })).not.toBeInTheDocument();
  });

  it('keeps the create modal open when Escape is pressed during save', async () => {
    const createResult = deferred<KnowledgeBase>();
    vi.mocked(createKnowledgeBase).mockReturnValue(createResult.promise);
    vi.mocked(listKnowledgeBaseTags).mockResolvedValue({ items: knowledgeBaseTags.slice(0, 1) });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases" element={<KnowledgeBaseListPage />} />
        <Route path="/knowledge-bases/:id/documents" element={<div>文档页</div>} />
      </Routes>,
      ['/knowledge-bases?intent=create'],
    );

    await user.click(await screen.findByText('更多设置'));
    const tag = await screen.findByRole('checkbox', { name: '制度' });
    await user.type(await screen.findByRole('textbox', { name: '名称' }), '新知识库');
    await user.click(screen.getByRole('button', { name: '创建并导入文档' }));
    await waitFor(() => expect(createKnowledgeBase).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '名称' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '描述' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '分类' })).toBeDisabled();
    expect(tag).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '访问权限' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '新建知识库' })).toBeInTheDocument();

    createResult.resolve(createdKnowledgeBase);
    expect(await screen.findByText('文档页')).toBeInTheDocument();
  });

  it('preserves the complete tag set when editing multiple tags', async () => {
    vi.mocked(listKnowledgeBaseTags).mockResolvedValue({ items: knowledgeBaseTags });
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [{ ...createdKnowledgeBase, tags: knowledgeBaseTags.slice(0, 2) }],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const row = (await screen.findByRole('link', { name: /新知识库/ })).closest('tr')!;
    await chooseKnowledgeBaseAction(user, row, '新知识库', '编辑');
    const dialog = screen.getByRole('dialog', { name: '编辑知识库' });
    expect(within(dialog).getByRole('checkbox', { name: '制度' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: '人事' })).toBeChecked();

    await user.click(within(dialog).getByRole('checkbox', { name: '人事' }));
    await user.click(within(dialog).getByRole('checkbox', { name: '财务' }));
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(updateKnowledgeBase).toHaveBeenCalledOnce());
    const payload = vi.mocked(updateKnowledgeBase).mock.calls[0]?.[1];
    expect(payload?.tagIds).toHaveLength(2);
    expect(payload?.tagIds).toEqual(expect.arrayContaining(['tag-a', 'tag-c']));
    expect(payload?.tagIds).not.toContain('tag-b');
  });

  it('asks before discarding a dirty knowledge-base form', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases" element={<KnowledgeBaseListPage />} />
      </Routes>,
      ['/knowledge-bases?intent=create'],
    );

    const name = await screen.findByRole('textbox', { name: '名称' });
    await user.type(name, '尚未保存的知识库');
    await user.keyboard('{Escape}');

    const confirmation = await screen.findByRole('dialog', { name: '放弃未保存的更改' });
    await user.click(within(confirmation).getByRole('button', { name: '继续编辑' }));
    expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('尚未保存的知识库');

    await user.keyboard('{Escape}');
    await user.click(within(
      await screen.findByRole('dialog', { name: '放弃未保存的更改' }),
    ).getByRole('button', { name: '放弃更改' }));
    expect(screen.queryByRole('dialog', { name: '新建知识库' })).not.toBeInTheDocument();
  });

  it('prioritizes document readiness, visibility, and update time in cards', async () => {
    vi.mocked(getWorkspacePreference).mockResolvedValue({
      viewMode: 'card',
      scope: 'all',
      sort: 'updatedAt_desc',
      visibility: 'all',
      expandedCategoryIds: [],
    });
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [
        {
          ...createdKnowledgeBase,
          id: 'kb-failed',
          name: '异常知识库',
          visibility: 'public',
          documentCount: 3,
          completedDocumentCount: 1,
          processingDocumentCount: 1,
          failedDocumentCount: 1,
          viewCount: 12,
          questionCount: 4,
        },
        {
          ...createdKnowledgeBase,
          id: 'kb-processing',
          name: '处理中知识库',
          documentCount: 2,
          completedDocumentCount: 1,
          processingDocumentCount: 1,
          failedDocumentCount: 0,
        },
        {
          ...createdKnowledgeBase,
          id: 'kb-ready',
          name: '可用知识库',
          documentCount: 1,
          completedDocumentCount: 1,
          processingDocumentCount: 0,
          failedDocumentCount: 0,
        },
        {
          ...createdKnowledgeBase,
          id: 'kb-empty',
          name: '空知识库',
          documentCount: 0,
          completedDocumentCount: 0,
          processingDocumentCount: 0,
          failedDocumentCount: 0,
        },
      ],
      total: 4,
      page: 1,
      pageSize: 10,
    });

    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const failedCard = (await screen.findByRole('link', { name: /异常知识库/ })).closest('article')!;
    expect(within(failedCard).getByText('存在失败')).toBeInTheDocument();
    expect(within(failedCard).getByText('公开')).toBeInTheDocument();
    expect(within(failedCard).getByText(/更新于/)).toBeInTheDocument();
    const readiness = within(failedCard).getByText('存在失败');
    const views = within(failedCard).getByText('12 浏览');
    expect(readiness.compareDocumentPosition(views) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(within((screen.getByRole('link', { name: /处理中知识库/ })).closest('article')!).getByText('处理中')).toBeInTheDocument();
    expect(within((screen.getByRole('link', { name: /可用知识库/ })).closest('article')!).getByText('可问答')).toBeInTheDocument();
    expect(within((screen.getByRole('link', { name: /空知识库/ })).closest('article')!).getByText('暂无文档')).toBeInTheDocument();
  });

  it('moves a knowledge base from the overflow menu', async () => {
    vi.mocked(listKnowledgeBaseCategories).mockResolvedValue({ items: categories });
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [createdKnowledgeBase],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const row = (await screen.findByRole('link', { name: /新知识库/ })).closest('tr')!;
    expect(within(row).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: '新知识库的更多操作' }));

    const menu = screen.getByRole('menu', { name: '新知识库的更多操作' });
    expect(within(menu).getByRole('menuitem', { name: '编辑' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '删除' })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: '移动到分类' }));

    const dialog = screen.getByRole('dialog', { name: '移动知识库' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '目标分类' }), 'category-b');
    await user.click(within(dialog).getByRole('button', { name: '移动' }));

    await waitFor(() => expect(batchMoveKnowledgeBases).toHaveBeenCalledWith(['kb-new'], 'category-b'));
  });

  it('keeps the move dialog and selection when moving a knowledge base fails', async () => {
    vi.mocked(listKnowledgeBaseCategories).mockResolvedValue({ items: categories });
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [createdKnowledgeBase],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    vi.mocked(batchMoveKnowledgeBases).mockRejectedValueOnce(new ApiError(409, {
      code: 'CATEGORY_UNAVAILABLE',
      message: '目标分类不可用',
    }));
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const row = (await screen.findByRole('link', { name: /新知识库/ })).closest('tr')!;
    await chooseKnowledgeBaseAction(user, row, '新知识库', '移动到分类');
    const dialog = screen.getByRole('dialog', { name: '移动知识库' });
    const category = within(dialog).getByRole('combobox', { name: '目标分类' });
    await user.selectOptions(category, 'category-b');
    await user.click(within(dialog).getByRole('button', { name: '移动' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('目标分类不可用');
    expect(category).toHaveValue('category-b');
    expect(within(dialog).getByRole('button', { name: '移动' })).toBeEnabled();
  });

  it('exposes the selected view mode to assistive technology', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases" element={<KnowledgeBaseListPage />} />
      </Routes>,
      ['/knowledge-bases'],
    );

    const table = await screen.findByRole('button', { name: '列表视图' });
    const card = screen.getByRole('button', { name: '卡片视图' });
    expect(table.querySelector('svg')).not.toBeNull();
    expect(card.querySelector('svg')).not.toBeNull();
    expect(table).toHaveAttribute('aria-pressed', 'true');
    expect(card).toHaveAttribute('aria-pressed', 'false');

    await user.click(card);
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(table).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not let an older list request overwrite the latest filter result', async () => {
    const first = deferred<{ items: KnowledgeBase[]; total: number; page: number; pageSize: number }>();
    const second = deferred<{ items: KnowledgeBase[]; total: number; page: number; pageSize: number }>();
    vi.mocked(listKnowledgeBases)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases" element={<KnowledgeBaseListPage />} />
      </Routes>,
      ['/knowledge-bases'],
    );

    await waitFor(() => expect(listKnowledgeBases).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('tab', { name: '收藏的' }));
    await waitFor(() => expect(listKnowledgeBases).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({ items: [secondKnowledgeBase], total: 1, page: 1, pageSize: 10 });
      await Promise.resolve();
    });
    expect(await screen.findByText('最新筛选结果')).toBeInTheDocument();

    await act(async () => {
      first.resolve({ items: [createdKnowledgeBase], total: 1, page: 1, pageSize: 10 });
      await Promise.resolve();
    });
    expect(screen.getByText('最新筛选结果')).toBeInTheDocument();
    expect(screen.queryByText('新知识库')).not.toBeInTheDocument();
  });

  it('serializes preference saves so the latest value is persisted last', async () => {
    const first = deferred<ReturnType<typeof preferenceValue>>();
    const second = deferred<ReturnType<typeof preferenceValue>>();
    vi.mocked(updateWorkspacePreference)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases" element={<KnowledgeBaseListPage />} />
      </Routes>,
      ['/knowledge-bases'],
    );

    const card = await screen.findByRole('button', { name: '卡片视图' });
    const table = screen.getByRole('button', { name: '列表视图' });
    await user.click(card);
    await user.click(table);
    expect(updateWorkspacePreference).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(preferenceValue('card'));
      await Promise.resolve();
    });
    await waitFor(() => expect(updateWorkspacePreference).toHaveBeenCalledTimes(2));
    expect(updateWorkspacePreference).toHaveBeenNthCalledWith(2, preferenceValue('table'));

    await act(async () => {
      second.resolve(preferenceValue('table'));
      await Promise.resolve();
    });

    expect(table).toHaveAttribute('aria-pressed', 'true');
    expect(card).toHaveAttribute('aria-pressed', 'false');
  });

  it('drops a queued preference save after the page unmounts', async () => {
    const first = deferred<ReturnType<typeof preferenceValue>>();
    vi.mocked(updateWorkspacePreference).mockReturnValueOnce(first.promise);
    const user = userEvent.setup();
    const { unmount } = renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const card = await screen.findByRole('button', { name: '卡片视图' });
    const table = screen.getByRole('button', { name: '列表视图' });
    await user.click(card);
    await user.click(table);
    expect(updateWorkspacePreference).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      first.resolve(preferenceValue('card'));
      await Promise.resolve();
    });

    expect(updateWorkspacePreference).toHaveBeenCalledTimes(1);
  });

  it('does not consume a category refresh response after the page unmounts', async () => {
    const categoryReload = deferred<{ items: typeof categories }>();
    const readItems = vi.fn();
    vi.mocked(listKnowledgeBaseCategories)
      .mockResolvedValueOnce({ items: categories })
      .mockReturnValueOnce(categoryReload.promise);
    vi.mocked(reorderKnowledgeBaseCategories).mockResolvedValue({ processedCount: 2 });
    const { unmount } = renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    (await screen.findByRole('button', { name: '制度分类 下移' })).click();
    await waitFor(() => expect(listKnowledgeBaseCategories).toHaveBeenCalledTimes(2));
    unmount();

    categoryReload.resolve({
      get items() {
        readItems();
        return categories;
      },
    });
    readItems.mockClear();
    await act(async () => {
      await Promise.resolve();
    });

    expect(readItems).not.toHaveBeenCalled();
  });

  it('continues with a pending preference after an earlier save fails', async () => {
    const first = deferred<ReturnType<typeof preferenceValue>>();
    const second = deferred<ReturnType<typeof preferenceValue>>();
    vi.mocked(updateWorkspacePreference)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const card = await screen.findByRole('button', { name: '卡片视图' });
    const table = screen.getByRole('button', { name: '列表视图' });
    await user.click(card);
    await user.click(table);

    first.reject(new Error('offline'));
    await waitFor(() => expect(updateWorkspacePreference).toHaveBeenCalledTimes(2));
    expect(table).toHaveAttribute('aria-pressed', 'true');

    second.resolve(preferenceValue('table'));
    await waitFor(() => expect(screen.queryByText('工作台偏好保存失败')).not.toBeInTheDocument());
    expect(table).toHaveAttribute('aria-pressed', 'true');
  });

  it('rolls back a failed queued preference to the latest confirmed value', async () => {
    const first = deferred<ReturnType<typeof preferenceValue>>();
    const second = deferred<ReturnType<typeof preferenceValue>>();
    vi.mocked(updateWorkspacePreference)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const card = await screen.findByRole('button', { name: '卡片视图' });
    const table = screen.getByRole('button', { name: '列表视图' });
    await user.click(card);
    await user.click(table);

    first.resolve(preferenceValue('card'));
    await waitFor(() => expect(updateWorkspacePreference).toHaveBeenCalledTimes(2));
    second.reject(new Error('offline'));

    expect(await screen.findByRole('alert')).toHaveTextContent('工作台偏好保存失败');
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(table).toHaveAttribute('aria-pressed', 'false');
  });

  it('restores the confirmed preference after a failed save and clears the error after recovery', async () => {
    vi.mocked(updateWorkspacePreference)
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async (preference) => preference);
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const card = await screen.findByRole('button', { name: '卡片视图' });
    const table = screen.getByRole('button', { name: '列表视图' });
    await user.click(card);

    expect(await screen.findByRole('alert')).toHaveTextContent('工作台偏好保存失败');
    expect(table).toHaveAttribute('aria-pressed', 'true');
    expect(card).toHaveAttribute('aria-pressed', 'false');

    await user.click(card);
    await waitFor(() => expect(updateWorkspacePreference).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('工作台偏好保存失败')).not.toBeInTheDocument());
    expect(card).toHaveAttribute('aria-pressed', 'true');
  });

  it('uses labelled Lucide icons for view, favorite, and pagination controls', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [createdKnowledgeBase], total: 11, page: 1, pageSize: 10 });
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const favorite = await screen.findByRole('button', { name: '收藏' });
    expect(favorite.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: '上一页' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: '下一页' }).querySelector('svg')).not.toBeNull();
  });

  it('shows a knowledge-base recycle-bin refresh failure inside the drawer', async () => {
    vi.mocked(listKnowledgeBaseRecycleBin)
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 })
      .mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    await user.click(await screen.findByRole('button', { name: '回收站 0' }));
    const drawer = screen.getByRole('dialog', { name: '知识库回收站' });

    const alert = await within(drawer).findByRole('alert');
    expect(alert).toHaveTextContent('知识库回收站加载失败');
    expect(within(drawer).queryByText('知识库回收站为空。')).not.toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: '重试加载' })).toBeInTheDocument();
  });

  it('shows a recycle-bin refresh failure after a successful restore', async () => {
    const recycleItem = {
      resourceType: 'knowledgeBase' as const,
      id: 'deleted-kb',
      name: '已删除知识库',
      deletedAt: '2026-07-01T00:00:00Z',
    };
    vi.mocked(listKnowledgeBaseRecycleBin)
      .mockResolvedValueOnce({ items: [recycleItem], total: 1, page: 1, pageSize: 20 })
      .mockResolvedValueOnce({ items: [recycleItem], total: 1, page: 1, pageSize: 20 })
      .mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    await user.click(await screen.findByRole('button', { name: '回收站 1' }));
    const drawer = screen.getByRole('dialog', { name: '知识库回收站' });
    await user.click(await within(drawer).findByRole('button', { name: '恢复' }));

    expect(await within(drawer).findByRole('alert')).toHaveTextContent('知识库回收站加载失败');
  });

  it('locks every recycle-bin mutation while restoring one knowledge base', async () => {
    const restoreResult = deferred<void>();
    vi.mocked(restoreKnowledgeBase).mockReturnValue(restoreResult.promise);
    const recycleItems = [
      { resourceType: 'knowledgeBase' as const, id: 'deleted-a', name: '已删除 A', deletedAt: '2026-07-01T00:00:00Z' },
      { resourceType: 'knowledgeBase' as const, id: 'deleted-b', name: '已删除 B', deletedAt: '2026-07-02T00:00:00Z' },
    ];
    vi.mocked(listKnowledgeBaseRecycleBin).mockResolvedValue({
      items: recycleItems, total: 2, page: 1, pageSize: 20,
    });
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    await user.click(await screen.findByRole('button', { name: '回收站 2' }));
    const drawer = screen.getByRole('dialog', { name: '知识库回收站' });
    const firstItem = (await within(drawer).findByText('已删除 A')).closest('article')!;
    const secondItem = within(drawer).getByText('已删除 B').closest('article')!;
    await user.click(within(firstItem).getByRole('button', { name: '恢复' }));

    expect(within(secondItem).getByRole('button', { name: '恢复' })).toBeDisabled();
    expect(within(secondItem).getByRole('button', { name: '永久删除' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: '恢复全部' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: '清空回收站' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: '关闭' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '知识库回收站' })).toBeInTheDocument();

    restoreResult.resolve();
    await waitFor(() => expect(restoreKnowledgeBase).toHaveBeenCalledWith('deleted-a'));
  });

  it('keeps a knowledge-base delete failure inside the confirmation dialog', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [createdKnowledgeBase], total: 1, page: 1, pageSize: 10 });
    vi.mocked(deleteKnowledgeBase).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseListPage />, ['/knowledge-bases']);

    const row = (await screen.findByRole('link', { name: /新知识库/ })).closest('tr')!;
    await chooseKnowledgeBaseAction(user, row, '新知识库', '删除');
    const confirmation = screen.getByRole('dialog', { name: '删除知识库' });
    await user.click(within(confirmation).getByRole('button', { name: '删除' }));

    expect(await within(confirmation).findByRole('alert')).toHaveTextContent('知识库删除失败');
  });
});

function preferenceValue(viewMode: 'card' | 'table') {
  return {
    viewMode,
    scope: 'all' as const,
    sort: 'updatedAt_desc' as const,
    visibility: 'all' as const,
    expandedCategoryIds: [],
  };
}
