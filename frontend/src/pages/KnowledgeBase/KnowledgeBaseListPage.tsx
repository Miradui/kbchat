import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ApiError } from '../../api/client';
import {
  batchDeleteKnowledgeBases,
  batchFavoriteKnowledgeBases,
  batchMoveKnowledgeBases,
  batchRestoreKnowledgeBases,
  createKnowledgeBase,
  createKnowledgeBaseCategory,
  deleteKnowledgeBaseCategory,
  deleteKnowledgeBase,
  deleteKnowledgeBasePermanently,
  emptyKnowledgeBaseRecycleBin,
  favoriteKnowledgeBase,
  getKnowledgeBaseStats,
  getWorkspacePreference,
  listKnowledgeBaseCategories,
  listKnowledgeBaseRecycleBin,
  listKnowledgeBases,
  listKnowledgeBaseTags,
  logout,
  recordKnowledgeBaseView,
  reorderKnowledgeBaseCategories,
  restoreKnowledgeBase,
  unfavoriteKnowledgeBase,
  updateKnowledgeBase,
  updateKnowledgeBaseCategory,
  updateWorkspacePreference,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import { useDialogModal } from '../../components/ui/Dialog';
import { tokenStore } from '../../store/tokenStore';
import type {
  KnowledgeBase,
  KnowledgeBaseCategory,
  KnowledgeBaseCategoryInput,
  KnowledgeBaseCategoryReorderItem,
  KnowledgeBaseInput,
  KnowledgeBaseScope,
  KnowledgeBaseSort,
  KnowledgeBaseStatsResponse,
  KnowledgeBaseTag,
  KnowledgeBaseWorkspacePreference,
  RetrievalConfig,
  RecycleBinItem,
  WorkspaceViewMode,
  WorkspaceVisibility,
} from '../../types/api';

const defaultConfig: RetrievalConfig = {
  vectorTopN: 30,
  rerankTopK: 5,
  scoreThreshold: 0.3,
  enableRerank: true,
};

const defaultPreference: KnowledgeBaseWorkspacePreference = {
  viewMode: 'table',
  scope: 'all',
  sort: 'updatedAt_desc',
  visibility: 'all',
  expandedCategoryIds: [],
};

const pageSizeOptions = [10, 20, 50];
const mutationRefreshError = '操作已成功，但页面数据刷新失败。无需重复提交，请刷新页面查看最新结果。';

type FormState = {
  id?: string;
  name: string;
  description: string;
  categoryId: string;
  visibility: 'private' | 'public';
  tagIds: string[];
};

type DeleteTarget =
  | { kind: 'single'; item: KnowledgeBase }
  | { kind: 'batch'; ids: string[] };

type CategoryFormState = {
  id?: string;
  name: string;
  parentId: string;
  sortOrder: number;
};

const emptyForm: FormState = {
  name: '',
  description: '',
  categoryId: '',
  visibility: 'private',
  tagIds: [],
};

export function KnowledgeBaseListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<KnowledgeBase[]>([]);
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [tags, setTags] = useState<KnowledgeBaseTag[]>([]);
  const [stats, setStats] = useState<KnowledgeBaseStatsResponse | null>(null);
  const [preference, setPreference] = useState<KnowledgeBaseWorkspacePreference>(defaultPreference);
  const [recycleItems, setRecycleItems] = useState<RecycleBinItem[]>([]);
  const [recycleCount, setRecycleCount] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkCategoryId, setBulkCategoryId] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState('');
  const [categoryForm, setCategoryForm] = useState<CategoryFormState | null>(null);
  const [categoryDeleteTarget, setCategoryDeleteTarget] = useState<KnowledgeBaseCategory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<RecycleBinItem | null>(null);
  const [confirmEmptyRecycleBin, setConfirmEmptyRecycleBin] = useState(false);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [query, setQuery] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const flatCategories = useMemo(() => flattenCategories(categories), [categories]);
  const categoryParentOptions = useMemo(() => {
    if (!categoryForm?.id) {
      return flatCategories;
    }
    const blockedIds = new Set([categoryForm.id, ...descendantCategoryIds(categories, categoryForm.id)]);
    return flatCategories.filter((category) => !blockedIds.has(category.id));
  }, [categories, categoryForm?.id, flatCategories]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const loadRecycleBin = useCallback(async () => {
    const response = await listKnowledgeBaseRecycleBin(1, 20);
    setRecycleItems(response.items);
    setRecycleCount(response.total);
    return response;
  }, []);

  const reloadCategories = useCallback(async () => {
    const response = await listKnowledgeBaseCategories();
    setCategories(response.items);
    return response.items;
  }, []);

  const loadWorkspace = useCallback(async (reportError = true) => {
    setLoading(true);
    setError('');

    try {
      const response = await listKnowledgeBases({
        q: query,
        categoryId: categoryFilter || undefined,
        tagIds: tagFilter ? [tagFilter] : undefined,
        visibility: preference.visibility,
        scope: preference.scope,
        sort: preference.sort,
        page,
        pageSize,
      });
      setItems(response.items);
      setTotal(response.total ?? response.items.length);
      setSelectedIds((current) =>
        current.filter((id) => response.items.some((item) => item.id === id)),
      );
      return true;
    } catch (err) {
      if (reportError) {
        setError(errorMessage(err, '知识库加载失败'));
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, page, pageSize, preference.scope, preference.sort, preference.visibility, query, tagFilter]);

  useEffect(() => {
    let mounted = true;

    Promise.all([
      getWorkspacePreference().catch(() => defaultPreference),
      listKnowledgeBaseCategories(),
      listKnowledgeBaseTags().catch(() => ({ items: [] })),
      getKnowledgeBaseStats('month'),
      listKnowledgeBaseRecycleBin(1, 20).catch(() => ({ items: [], total: 0, page: 1, pageSize: 20 })),
    ])
      .then(([pref, categoryResponse, tagResponse, statsResponse, recycleResponse]) => {
        if (!mounted) {
          return;
        }
        setPreference(pref);
        setCategories(categoryResponse.items);
        setTags(tagResponse.items);
        setStats(statsResponse);
        setRecycleItems(recycleResponse.items);
        setRecycleCount(recycleResponse.total);
      })
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '工作台初始化失败'));
        }
      })
      .finally(() => {
        if (mounted) {
          setBootstrapping(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!bootstrapping) {
      void loadWorkspace();
    }
  }, [bootstrapping, loadWorkspace]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  async function persistPreference(next: KnowledgeBaseWorkspacePreference) {
    setPreference(next);
    try {
      const saved = await updateWorkspacePreference(next);
      setPreference(saved);
    } catch (err) {
      setError(errorMessage(err, '工作台偏好保存失败'));
    }
  }

  function updateScope(scope: KnowledgeBaseScope) {
    setPage(1);
    void persistPreference({ ...preference, scope });
  }

  function updateVisibility(visibility: WorkspaceVisibility) {
    setPage(1);
    void persistPreference({ ...preference, visibility });
  }

  function updateSort(sort: KnowledgeBaseSort) {
    setPage(1);
    void persistPreference({ ...preference, sort });
  }

  function updateViewMode(viewMode: WorkspaceViewMode) {
    void persistPreference({ ...preference, viewMode });
  }

  function toggleCategoryExpanded(categoryId: string) {
    const expanded = new Set(preference.expandedCategoryIds);
    if (expanded.has(categoryId)) {
      expanded.delete(categoryId);
    } else {
      expanded.add(categoryId);
    }
    void persistPreference({ ...preference, expandedCategoryIds: Array.from(expanded) });
  }

  function openCreateCategory(parentId = '') {
    setCategoryForm({
      name: '',
      parentId,
      sortOrder: nextCategorySortOrder(categories, parentId || null),
    });
  }

  function openEditCategory(category: KnowledgeBaseCategory) {
    setCategoryForm({
      id: category.id,
      name: category.name,
      parentId: category.parentId ?? '',
      sortOrder: category.sortOrder,
    });
  }

  async function handleCategorySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!categoryForm) {
      return;
    }

    setSubmitting(true);
    setFormError('');

    const input: KnowledgeBaseCategoryInput = {
      name: categoryForm.name.trim(),
      parentId: categoryForm.parentId || null,
      sortOrder: categoryForm.sortOrder,
    };

    try {
      if (categoryForm.id) {
        await updateKnowledgeBaseCategory(categoryForm.id, input);
      } else {
        await createKnowledgeBaseCategory(input);
      }
      setCategoryForm(null);
      await reloadCategories();
    } catch (err) {
      setError(errorMessage(err, '分类保存失败'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCategoryDelete() {
    if (!categoryDeleteTarget) {
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await deleteKnowledgeBaseCategory(categoryDeleteTarget.id);
      if (categoryFilter === categoryDeleteTarget.id) {
        setCategoryFilter('');
      }
      setCategoryDeleteTarget(null);
      await reloadCategories();
    } catch (err) {
      setError(errorMessage(err, '分类删除失败'));
    } finally {
      setSubmitting(false);
    }
  }

  async function moveCategory(categoryId: string, direction: 'up' | 'down') {
    const itemsForReorder = categoryReorderItemsAfterMove(categories, categoryId, direction);
    if (!itemsForReorder) {
      return;
    }

    setWorkingId(categoryId);
    setError('');

    try {
      await reorderKnowledgeBaseCategories(itemsForReorder);
      await reloadCategories();
    } catch (err) {
      setError(errorMessage(err, '分类排序保存失败'));
    } finally {
      setWorkingId(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) {
      return;
    }

    setSubmitting(true);
    setError('');

    const input: KnowledgeBaseInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      categoryId: form.categoryId || null,
      visibility: form.visibility,
      retrievalConfig: form.id
        ? items.find((item) => item.id === form.id)?.retrievalConfig ?? defaultConfig
        : defaultConfig,
      tagIds: form.tagIds,
    };

    try {
      if (form.id) {
        await updateKnowledgeBase(form.id, input);
      } else {
        await createKnowledgeBase(input);
      }
      setForm(null);
      setFormError('');
      await refreshAfterMutation();
    } catch (err) {
      setFormError(errorMessage(err, '知识库保存失败'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) {
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      if (deleteTarget.kind === 'single') {
        await deleteKnowledgeBase(deleteTarget.item.id);
      } else {
        await batchDeleteKnowledgeBases(deleteTarget.ids);
      }
      setDeleteTarget(null);
      await refreshAfterMutation();
    } catch (err) {
      setError(errorMessage(err, '知识库删除失败'));
    } finally {
      setSubmitting(false);
    }
  }

  async function refreshAfterMutation() {
    const [statsRefreshed, recycleRefreshed, workspaceRefreshed] = await Promise.all([
      getKnowledgeBaseStats('month')
        .then((response) => {
          setStats(response);
          return true;
        })
        .catch(() => false),
      listKnowledgeBaseRecycleBin(1, 20)
        .then((response) => {
          setRecycleItems(response.items);
          setRecycleCount(response.total);
          return true;
        })
        .catch(() => false),
      loadWorkspace(false),
    ]);

    if (!statsRefreshed || !recycleRefreshed || !workspaceRefreshed) {
      setError(mutationRefreshError);
    }
  }

  async function handleRestoreRecycleItem(item: RecycleBinItem) {
    setWorkingId(item.id);
    setError('');

    try {
      await restoreKnowledgeBase(item.id);
      await refreshAfterMutation();
    } catch (err) {
      setError(errorMessage(err, '知识库恢复失败'));
    } finally {
      setWorkingId(null);
    }
  }

  async function handleRestoreAllRecycleItems() {
    const ids = recycleItems.map((item) => item.id);
    if (ids.length === 0) {
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await batchRestoreKnowledgeBases(ids);
      await refreshAfterMutation();
    } catch (err) {
      setError(errorMessage(err, '批量恢复失败'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePermanentDeleteKnowledgeBase() {
    if (!permanentDeleteTarget) {
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await deleteKnowledgeBasePermanently(permanentDeleteTarget.id);
      setPermanentDeleteTarget(null);
      await refreshAfterMutation();
    } catch (err) {
      setError(errorMessage(err, '知识库永久删除失败'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEmptyKnowledgeBaseRecycleBin() {
    setSubmitting(true);
    setError('');

    try {
      await emptyKnowledgeBaseRecycleBin();
      setConfirmEmptyRecycleBin(false);
      await refreshAfterMutation();
    } catch (err) {
      setError(errorMessage(err, '清空失败，后端按 all-or-nothing 语义未执行部分删除。'));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleFavorite(item: KnowledgeBase) {
    setWorkingId(item.id);
    setError('');

    try {
      if (item.isFavorite) {
        await unfavoriteKnowledgeBase(item.id);
      } else {
        await favoriteKnowledgeBase(item.id);
      }
      await loadWorkspace();
    } catch (err) {
      setError(errorMessage(err, '收藏状态更新失败'));
    } finally {
      setWorkingId(null);
    }
  }

  async function handleBatchFavorite(favorite: boolean) {
    if (selectedIds.length === 0) {
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await batchFavoriteKnowledgeBases(selectedIds, favorite);
      await loadWorkspace();
    } catch (err) {
      setError(errorMessage(err, '批量收藏更新失败'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBatchMoveCategory() {
    if (selectedIds.length === 0) {
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await batchMoveKnowledgeBases(selectedIds, bulkCategoryId || null);
      setSelectedIds([]);
      await refreshAfterMutation();
    } catch (err) {
      setError(errorMessage(err, '批量移动分类失败'));
    } finally {
      setSubmitting(false);
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleAllVisible() {
    const visibleIds = items.map((item) => item.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
    setSelectedIds(allSelected ? [] : visibleIds);
  }

  function openCreateForm() {
    setFormError('');
    setForm(emptyForm);
  }

  function openEditForm(item: KnowledgeBase) {
    setFormError('');
    setForm({
      id: item.id,
      name: item.name,
      description: item.description,
      categoryId: item.categoryId ?? '',
      visibility: item.visibility ?? 'private',
      tagIds: item.tags?.map((tag) => tag.id) ?? [],
    });
  }

  function closeKnowledgeBaseForm() {
    setForm(null);
    setFormError('');
  }

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setQuery(searchDraft.trim());
  }

  function applyGlobalSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const keyword = searchDraft.trim();
    if (keyword) {
      navigate(`/search?q=${encodeURIComponent(keyword)}`);
    }
  }

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // Local logout should still happen if the server token is already invalid.
    } finally {
      tokenStore.clearToken();
      navigate('/login', { replace: true });
    }
  }

  function selectCategory(categoryId: string) {
    setCategoryFilter((current) => (current === categoryId ? '' : categoryId));
    setPage(1);
  }

  async function handleOpenKnowledgeBase(item: KnowledgeBase) {
    recordKnowledgeBaseView(item.id).catch(() => undefined);
  }

  const allVisibleSelected = items.length > 0 && items.every((item) => selectedSet.has(item.id));
  const listRefreshing = loading && !bootstrapping && items.length > 0;

  const knowledgeBaseTopbar = (
    <header className="workspace-topbar">
      <form className="global-search" onSubmit={applyGlobalSearch}>
        <span aria-hidden="true">⌕</span>
        <input
          aria-label="搜索知识库"
          placeholder="搜索知识库、文档、内容"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
        />
        <kbd>⌘ K</kbd>
      </form>
      <div className="topbar-actions" aria-label="用户工具">
        <button className="icon-button" type="button" title="通知" aria-label="通知">
          bell
        </button>
        <button className="icon-button" type="button" title="帮助" aria-label="帮助">
          ?
        </button>
        <button className="secondary-button" type="button" onClick={() => void handleLogout()}>
          退出登录
        </button>
      </div>
    </header>
  );

  return (
    <WorkspaceShell
      active="knowledge-bases"
      categories={categories}
      categoryFilter={categoryFilter}
      expandedIds={preference.expandedCategoryIds}
      categoryWorkingId={workingId}
      topbar={knowledgeBaseTopbar}
      onCreateCategory={openCreateCategory}
      onDeleteCategory={setCategoryDeleteTarget}
      onEditCategory={openEditCategory}
      onMoveCategory={moveCategory}
      onSelectCategory={selectCategory}
      onToggleExpanded={toggleCategoryExpanded}
    >
          <header className="page-header workspace-heading">
            <div>
              <h1>知识库</h1>
              <p className="page-description">集中管理和组织您的知识资产，构建企业智慧大脑</p>
            </div>
            <div className="toolbar">
              <Link className="secondary-link" to={items[0] ? `/knowledge-bases/${items[0].id}/documents` : '/documents'}>
                导入文档
              </Link>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setShowRecycleBin(true);
                  void loadRecycleBin();
                }}
              >
                回收站 {recycleCount}
              </button>
              <button type="button" onClick={openCreateForm}>
                + 新建知识库
              </button>
            </div>
          </header>

          <StatsGrid stats={stats} fallbackTotal={total} />

          <div className="workspace-tabs" role="tablist" aria-label="知识库范围">
            {scopeTabs.map((tab) => (
              <button
                className={preference.scope === tab.value ? 'workspace-tab active' : 'workspace-tab'}
                key={tab.value}
                type="button"
                onClick={() => updateScope(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="workspace-controls">
            <select
              aria-label="知识库可见性"
              value={preference.visibility}
              onChange={(event) => updateVisibility(event.target.value as WorkspaceVisibility)}
            >
              <option value="all">全部类型</option>
              <option value="public">公开</option>
              <option value="private">私有</option>
            </select>
            <select
              aria-label="标签筛选"
              value={tagFilter}
              onChange={(event) => {
                setTagFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部标签</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
            <form className="inline-search" onSubmit={applySearch}>
              <input
                aria-label="搜索知识库名称、描述"
                placeholder="搜索知识库名称、描述"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </form>
            <div className="workspace-sort">
              <select
                aria-label="排序"
                value={preference.sort}
                onChange={(event) => updateSort(event.target.value as KnowledgeBaseSort)}
              >
                <option value="updatedAt_desc">最新更新</option>
                <option value="createdAt_desc">最新创建</option>
                <option value="name_asc">名称升序</option>
              </select>
              <div className="segmented-control" aria-label="视图模式">
                <button
                  className={preference.viewMode === 'card' ? 'active' : ''}
                  type="button"
                  onClick={() => updateViewMode('card')}
                  aria-label="卡片视图"
                >
                  grid
                </button>
                <button
                  className={preference.viewMode === 'table' ? 'active' : ''}
                  type="button"
                  onClick={() => updateViewMode('table')}
                  aria-label="列表视图"
                >
                  list
                </button>
              </div>
            </div>
          </div>

          {selectedIds.length > 0 && (
            <div className="bulk-bar">
              <span>已选择 {selectedIds.length} 项</span>
              <button className="secondary-button" type="button" onClick={() => void handleBatchFavorite(true)} disabled={submitting}>
                批量收藏
              </button>
              <button className="secondary-button" type="button" onClick={() => void handleBatchFavorite(false)} disabled={submitting}>
                取消收藏
              </button>
              <label className="inline-select bulk-category-select">
                移动到
                <select
                  value={bulkCategoryId}
                  onChange={(event) => setBulkCategoryId(event.target.value)}
                  disabled={submitting}
                >
                  <option value="">未分类</option>
                  {flatCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="secondary-button" type="button" onClick={() => void handleBatchMoveCategory()} disabled={submitting}>
                移动分类
              </button>
              <button className="danger-button" type="button" onClick={() => setDeleteTarget({ kind: 'batch', ids: selectedIds })} disabled={submitting}>
                批量删除
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setShowRecycleBin(true);
                  void loadRecycleBin();
                }}
              >
                回收站 {recycleCount}
              </button>
            </div>
          )}

          {categoryForm && (
            <form className="form-panel workspace-form category-form-panel" onSubmit={handleCategorySubmit}>
              <div>
                <h2>{categoryForm.id ? '编辑分类' : '新建分类'}</h2>
                <p className="page-description">分类用于工作台左侧树和知识库筛选；删除分类要求分类为空。</p>
              </div>
              <div className="form-grid">
                <label>
                  名称
                  <input
                    value={categoryForm.name}
                    onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })}
                    required
                  />
                </label>
                <label>
                  父分类
                  <select
                    value={categoryForm.parentId}
                    onChange={(event) => {
                      const parentId = event.target.value;
                      setCategoryForm({
                        ...categoryForm,
                        parentId,
                        sortOrder: nextCategorySortOrder(categories, parentId || null),
                      });
                    }}
                  >
                    <option value="">根分类</option>
                    {categoryParentOptions.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="form-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setCategoryForm(null)}
                  disabled={submitting}
                >
                  取消
                </button>
                <button type="submit" disabled={submitting}>
                  {submitting ? '保存中...' : '保存分类'}
                </button>
              </div>
            </form>
          )}

          {error && <p className="error-text">{error}</p>}

          <div className={listRefreshing ? 'workspace-list-panel is-refreshing' : 'workspace-list-panel'}>
            {(loading || bootstrapping) && items.length === 0 ? (
              <LoadingSkeleton rows={6} columns={5} />
            ) : items.length === 0 ? (
              <div className="empty-state">
                当前筛选下没有知识库。可以调整分类和范围，或新建一个知识库开始整理资料。
              </div>
            ) : preference.viewMode === 'card' ? (
              <KnowledgeBaseCards
                items={items}
                selectedSet={selectedSet}
                workingId={workingId}
                onDelete={(item) => setDeleteTarget({ kind: 'single', item })}
                onEdit={openEditForm}
                onFavorite={toggleFavorite}
                onOpen={handleOpenKnowledgeBase}
                onToggleSelected={toggleSelected}
              />
            ) : (
              <KnowledgeBaseTable
                allVisibleSelected={allVisibleSelected}
                items={items}
                selectedSet={selectedSet}
                workingId={workingId}
                onDelete={(item) => setDeleteTarget({ kind: 'single', item })}
                onEdit={openEditForm}
                onFavorite={toggleFavorite}
                onOpen={handleOpenKnowledgeBase}
                onToggleAll={toggleAllVisible}
                onToggleSelected={toggleSelected}
              />
            )}
          </div>

          <footer className="workspace-pagination">
            <span>共 {total} 条</span>
            <div className="pager">
              <button className="secondary-button" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                ‹
              </button>
              {paginationItems(page, totalPages).map((item) => (
                <button
                  className={item === page ? 'secondary-button active-page' : 'secondary-button'}
                  key={item}
                  type="button"
                  onClick={() => setPage(item)}
                >
                  {item}
                </button>
              ))}
              <button className="secondary-button" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                ›
              </button>
              <select
                aria-label="每页数量"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {pageSizeOptions.map((option) => (
                  <option key={option} value={option}>
                    {option} 条/页
                  </option>
                ))}
              </select>
            </div>
          </footer>
      {showRecycleBin && (
        <KnowledgeBaseRecycleBinDrawer
          busy={submitting}
          items={recycleItems}
          workingId={workingId}
          onClose={() => setShowRecycleBin(false)}
          onRefresh={() => void loadRecycleBin()}
          onDeletePermanently={setPermanentDeleteTarget}
          onEmpty={() => setConfirmEmptyRecycleBin(true)}
          onRestore={handleRestoreRecycleItem}
          onRestoreAll={handleRestoreAllRecycleItems}
        />
      )}

      {form && (
        <KnowledgeBaseFormDrawer
          busy={submitting}
          categories={flatCategories}
          error={formError}
          form={form}
          tags={tags}
          onChange={(nextForm) => {
            setForm(nextForm);
            if (formError) {
              setFormError('');
            }
          }}
          onClose={closeKnowledgeBaseForm}
          onSubmit={handleSubmit}
        />
      )}

      {categoryDeleteTarget && (
        <ConfirmDialog
          title="删除分类"
          description={`确认删除“${categoryDeleteTarget.name}”？后端只允许删除空分类。`}
          confirmLabel="删除"
          busy={submitting}
          onCancel={() => setCategoryDeleteTarget(null)}
          onConfirm={handleCategoryDelete}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={deleteTarget.kind === 'single' ? '删除知识库' : '批量删除知识库'}
          description={
            deleteTarget.kind === 'single'
              ? `确认删除“${deleteTarget.item.name}”？知识库会进入回收站。`
              : `确认删除选中的 ${deleteTarget.ids.length} 个知识库？这些知识库会进入回收站。`
          }
          confirmLabel="删除"
          busy={submitting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}

      {permanentDeleteTarget && (
        <ConfirmDialog
          title="永久删除知识库"
          description={`确认永久删除“${permanentDeleteTarget.name}”？关联文档、chunks、会话和成员等数据会被清理，且不可恢复。`}
          confirmLabel="永久删除"
          busy={submitting}
          onCancel={() => setPermanentDeleteTarget(null)}
          onConfirm={handlePermanentDeleteKnowledgeBase}
        />
      )}

      {confirmEmptyRecycleBin && (
        <ConfirmDialog
          title="清空知识库回收站"
          description="确认清空知识库回收站？后端按 all-or-nothing 语义执行，失败时不会产生部分删除。"
          confirmLabel="清空"
          busy={submitting}
          onCancel={() => setConfirmEmptyRecycleBin(false)}
          onConfirm={handleEmptyKnowledgeBaseRecycleBin}
        />
      )}
    </WorkspaceShell>
  );
}

function KnowledgeBaseFormDrawer({
  busy,
  categories,
  error,
  form,
  tags,
  onChange,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  categories: { id: string; label: string }[];
  error: string;
  form: FormState;
  tags: KnowledgeBaseTag[];
  onChange: (form: FormState) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const panelRef = useDialogModal<HTMLElement>(true, busy ? () => undefined : onClose);
  return (
    <aside className="drawer-backdrop" role="presentation">
      <section
        aria-labelledby="kb-form-title"
        aria-modal="true"
        className="drawer-panel kb-form-drawer"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="kb-form-title">{form.id ? '编辑知识库' : '新建知识库'}</h2>
            <p className="muted-text">分类、可见性和标签会直接提交到后端知识库接口。</p>
          </div>
          <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </header>

        <form className="drawer-form" onSubmit={onSubmit}>
          <div className="form-grid drawer-form-grid">
            <label>
              名称
              <input
                value={form.name}
                onChange={(event) => onChange({ ...form, name: event.target.value })}
                required
              />
            </label>
            <label>
              分类
              <select
                value={form.categoryId}
                onChange={(event) => onChange({ ...form, categoryId: event.target.value })}
              >
                <option value="">未分类</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              可见性
              <select
                value={form.visibility}
                onChange={(event) =>
                  onChange({ ...form, visibility: event.target.value as 'private' | 'public' })
                }
              >
                <option value="private">私有</option>
                <option value="public">公开</option>
              </select>
            </label>
            <label>
              标签
              <select
                value={form.tagIds[0] ?? ''}
                onChange={(event) =>
                  onChange({ ...form, tagIds: event.target.value ? [event.target.value] : [] })
                }
              >
                <option value="">不设置标签</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field-wide">
              描述
              <textarea
                value={form.description}
                onChange={(event) => onChange({ ...form, description: event.target.value })}
                rows={4}
              />
            </label>
          </div>

          {error && <p className="drawer-error-text">{error}</p>}

          <div className="form-actions drawer-form-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" disabled={busy}>
              {busy ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </section>
    </aside>
  );
}

function KnowledgeBaseRecycleBinDrawer({
  busy,
  items,
  workingId,
  onClose,
  onDeletePermanently,
  onEmpty,
  onRefresh,
  onRestore,
  onRestoreAll,
}: {
  busy: boolean;
  items: RecycleBinItem[];
  workingId: string | null;
  onClose: () => void;
  onDeletePermanently: (item: RecycleBinItem) => void;
  onEmpty: () => void;
  onRefresh: () => void;
  onRestore: (item: RecycleBinItem) => void;
  onRestoreAll: () => void;
}) {
  const panelRef = useDialogModal<HTMLElement>(true, onClose);
  return (
    <aside className="drawer-backdrop" role="presentation">
      <section
        aria-labelledby="kb-recycle-title"
        aria-modal="true"
        className="drawer-panel"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="kb-recycle-title">知识库回收站</h2>
            <p className="muted-text">展示当前用户已删除的知识库，可恢复后继续管理文档和会话。</p>
          </div>
          <button className="secondary-button" type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onRefresh}>
            刷新
          </button>
          <button className="secondary-button" type="button" onClick={onRestoreAll} disabled={busy || items.length === 0}>
            恢复全部
          </button>
          <button className="danger-button" type="button" onClick={onEmpty} disabled={busy || items.length === 0}>
            清空回收站
          </button>
        </div>

        <div className="recycle-list">
          {items.length === 0 ? (
            <div className="empty-state">知识库回收站为空。</div>
          ) : (
            items.map((item) => (
              <article className="recycle-item" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <span>删除时间 {formatDateTime(item.deletedAt)}</span>
                </div>
                <div className="table-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onRestore(item)}
                    disabled={workingId === item.id || busy}
                  >
                    {workingId === item.id ? '恢复中...' : '恢复'}
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    onClick={() => onDeletePermanently(item)}
                    disabled={busy}
                  >
                    永久删除
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </aside>
  );
}

function StatsGrid({ stats, fallbackTotal }: { stats: KnowledgeBaseStatsResponse | null; fallbackTotal: number }) {
  const cards = [
    { label: '知识库总数', metric: stats?.knowledgeBases, fallback: fallbackTotal, unit: '个', tone: 'blue' },
    { label: '文档总数', metric: stats?.documents, fallback: 0, unit: '篇', tone: 'green' },
    { label: '总浏览量', metric: stats?.views, fallback: 0, unit: '次', tone: 'violet' },
    { label: '问答总数', metric: stats?.questions, fallback: 0, unit: '条', tone: 'orange' },
  ];

  return (
    <div className="workspace-stats">
      {cards.map((card) => (
        <article className="workspace-stat-card" key={card.label}>
          <span className={`stat-icon ${card.tone}`} aria-hidden="true" />
          <div>
            <span>{card.label}</span>
            <strong>
              {formatNumber(card.metric?.value ?? card.fallback)}
              <small>{card.unit}</small>
            </strong>
            <em>较上月 {formatChange(card.metric?.changeRatio ?? 0)}</em>
          </div>
        </article>
      ))}
    </div>
  );
}

function KnowledgeBaseTable({
  allVisibleSelected,
  items,
  selectedSet,
  workingId,
  onDelete,
  onEdit,
  onFavorite,
  onOpen,
  onToggleAll,
  onToggleSelected,
}: {
  allVisibleSelected: boolean;
  items: KnowledgeBase[];
  selectedSet: Set<string>;
  workingId: string | null;
  onDelete: (item: KnowledgeBase) => void;
  onEdit: (item: KnowledgeBase) => void;
  onFavorite: (item: KnowledgeBase) => void;
  onOpen: (item: KnowledgeBase) => void;
  onToggleAll: () => void;
  onToggleSelected: (id: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table workspace-table">
        <thead>
          <tr>
            <th>
              <input
                aria-label="选择当前页全部知识库"
                checked={allVisibleSelected}
                type="checkbox"
                onChange={onToggleAll}
              />
            </th>
            <th>名称</th>
            <th>类型</th>
            <th>文档数</th>
            <th>更新人</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td data-label="选择">
                <input
                  aria-label={`选择 ${item.name}`}
                  checked={selectedSet.has(item.id)}
                  type="checkbox"
                  onChange={() => onToggleSelected(item.id)}
                />
              </td>
              <td className="table-title" data-label="名称">
                <Link className="kb-name-cell" to={`/knowledge-bases/${item.id}`} onClick={() => void onOpen(item)}>
                  <span className={`kb-icon ${item.visibility === 'public' ? 'public' : 'private'}`} aria-hidden="true" />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.description || '未填写描述'}</small>
                  </span>
                </Link>
              </td>
              <td data-label="类型">
                <span className={item.visibility === 'public' ? 'visibility-pill public' : 'visibility-pill private'}>
                  {item.visibility === 'public' ? '公开' : '私有'}
                </span>
              </td>
              <td data-label="文档数">{item.documentCount ?? 0}</td>
              <td data-label="更新人">
                <UserCell user={item.updatedBy} />
              </td>
              <td data-label="更新时间">{formatDateTime(item.updatedAt || item.createdAt)}</td>
              <td data-label="操作">
                <RowActions
                  item={item}
                  working={workingId === item.id}
                  onDelete={onDelete}
                  onEdit={onEdit}
                  onFavorite={onFavorite}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KnowledgeBaseCards({
  items,
  selectedSet,
  workingId,
  onDelete,
  onEdit,
  onFavorite,
  onOpen,
  onToggleSelected,
}: {
  items: KnowledgeBase[];
  selectedSet: Set<string>;
  workingId: string | null;
  onDelete: (item: KnowledgeBase) => void;
  onEdit: (item: KnowledgeBase) => void;
  onFavorite: (item: KnowledgeBase) => void;
  onOpen: (item: KnowledgeBase) => void;
  onToggleSelected: (id: string) => void;
}) {
  return (
    <div className="kb-card-grid">
      {items.map((item) => (
        <article className="kb-card" key={item.id}>
          <header>
            <input
              aria-label={`选择 ${item.name}`}
              checked={selectedSet.has(item.id)}
              type="checkbox"
              onChange={() => onToggleSelected(item.id)}
            />
            <span className={`kb-icon ${item.visibility === 'public' ? 'public' : 'private'}`} aria-hidden="true" />
            <RowActions
              item={item}
              working={workingId === item.id}
              onDelete={onDelete}
              onEdit={onEdit}
              onFavorite={onFavorite}
            />
          </header>
          <Link to={`/knowledge-bases/${item.id}`} onClick={() => void onOpen(item)}>
            <strong>{item.name}</strong>
            <p>{item.description || '未填写描述'}</p>
          </Link>
          <div className="kb-card-meta">
            <span>{item.documentCount ?? 0} 文档</span>
            <span>{item.viewCount ?? 0} 浏览</span>
            <span>{item.questionCount ?? 0} 问答</span>
          </div>
          <div className="tag-row">
            {(item.tags ?? []).slice(0, 3).map((tag) => (
              <span className="tag-pill" key={tag.id}>{tag.name}</span>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function RowActions({
  item,
  working,
  onDelete,
  onEdit,
  onFavorite,
}: {
  item: KnowledgeBase;
  working: boolean;
  onDelete: (item: KnowledgeBase) => void;
  onEdit: (item: KnowledgeBase) => void;
  onFavorite: (item: KnowledgeBase) => void;
}) {
  return (
    <div className="table-actions row-actions">
      <button
        className={item.isFavorite ? 'star-button active' : 'star-button'}
        type="button"
        aria-label={item.isFavorite ? '取消收藏' : '收藏'}
        disabled={working}
        onClick={() => void onFavorite(item)}
      >
        ☆
      </button>
      <button className="link-button" type="button" onClick={() => onEdit(item)}>
        编辑
      </button>
      <button className="link-button" type="button" onClick={() => onDelete(item)}>
        删除
      </button>
    </div>
  );
}

function UserCell({ user }: { user?: { displayName: string; username: string; avatarUrl?: string } }) {
  const name = user?.displayName || user?.username || '未知';
  return (
    <span className="user-cell">
      {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span aria-hidden="true">{name.slice(0, 1)}</span>}
      {name}
    </span>
  );
}

const scopeTabs: { label: string; value: KnowledgeBaseScope }[] = [
  { label: '全部', value: 'all' },
  { label: '我创建的', value: 'created' },
  { label: '我管理的', value: 'managed' },
  { label: '收藏的', value: 'favorite' },
  { label: '最近浏览', value: 'recent' },
];

function flattenCategories(categories: KnowledgeBaseCategory[], level = 0): { id: string; label: string }[] {
  return categories.flatMap((category) => [
    { id: category.id, label: `${'　'.repeat(level)}${category.name}` },
    ...flattenCategories(category.children ?? [], level + 1),
  ]);
}

function descendantCategoryIds(categories: KnowledgeBaseCategory[], categoryId: string): string[] {
  for (const category of categories) {
    if (category.id === categoryId) {
      return flattenCategoryIds(category.children ?? []);
    }

    const childIds = descendantCategoryIds(category.children ?? [], categoryId);
    if (childIds.length > 0) {
      return childIds;
    }
  }

  return [];
}

function flattenCategoryIds(categories: KnowledgeBaseCategory[]): string[] {
  return categories.flatMap((category) => [category.id, ...flattenCategoryIds(category.children ?? [])]);
}

function nextCategorySortOrder(categories: KnowledgeBaseCategory[], parentId: string | null): number {
  const siblings = findCategorySiblings(categories, parentId);
  const lastSortOrder = siblings.reduce((max, category) => Math.max(max, category.sortOrder), 0);
  return lastSortOrder + 10;
}

function categoryReorderItemsAfterMove(
  categories: KnowledgeBaseCategory[],
  categoryId: string,
  direction: 'up' | 'down',
): KnowledgeBaseCategoryReorderItem[] | null {
  const siblingGroup = findCategorySiblingGroup(categories, categoryId);
  if (!siblingGroup) {
    return null;
  }

  const siblings = sortCategories(siblingGroup.siblings);
  const currentIndex = siblings.findIndex((category) => category.id === categoryId);
  const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= siblings.length) {
    return null;
  }

  const reordered = [...siblings];
  [reordered[currentIndex], reordered[nextIndex]] = [reordered[nextIndex], reordered[currentIndex]];

  const sortOrderById = new Map<string, number>();
  reordered.forEach((category, index) => {
    sortOrderById.set(category.id, (index + 1) * 10);
  });

  return flattenCategoryReorderItems(categories, sortOrderById);
}

function findCategorySiblings(
  categories: KnowledgeBaseCategory[],
  parentId: string | null,
): KnowledgeBaseCategory[] {
  if (parentId === null) {
    return categories;
  }

  const parent = findCategoryById(categories, parentId);
  return parent?.children ?? [];
}

function findCategorySiblingGroup(
  categories: KnowledgeBaseCategory[],
  categoryId: string,
): { parentId: string | null; siblings: KnowledgeBaseCategory[] } | null {
  if (categories.some((category) => category.id === categoryId)) {
    return { parentId: null, siblings: categories };
  }

  for (const category of categories) {
    const children = category.children ?? [];
    if (children.some((child) => child.id === categoryId)) {
      return { parentId: category.id, siblings: children };
    }

    const found = findCategorySiblingGroup(children, categoryId);
    if (found) {
      return found;
    }
  }

  return null;
}

function findCategoryById(
  categories: KnowledgeBaseCategory[],
  categoryId: string,
): KnowledgeBaseCategory | null {
  for (const category of categories) {
    if (category.id === categoryId) {
      return category;
    }

    const found = findCategoryById(category.children ?? [], categoryId);
    if (found) {
      return found;
    }
  }

  return null;
}

function flattenCategoryReorderItems(
  categories: KnowledgeBaseCategory[],
  sortOrderById: Map<string, number>,
  parentId: string | null = null,
): KnowledgeBaseCategoryReorderItem[] {
  return categories.flatMap((category) => {
    const itemParentId = category.parentId ?? parentId;
    return [
      {
        id: category.id,
        parentId: itemParentId,
        sortOrder: sortOrderById.get(category.id) ?? category.sortOrder,
      },
      ...flattenCategoryReorderItems(category.children ?? [], sortOrderById, category.id),
    ];
  });
}

function sortCategories(categories: KnowledgeBaseCategory[]): KnowledgeBaseCategory[] {
  return [...categories].sort((left, right) => {
    const sortDiff = left.sortOrder - right.sortOrder;
    if (sortDiff !== 0) {
      return sortDiff;
    }
    return left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id);
  });
}

function paginationItems(page: number, totalPages: number): number[] {
  const start = Math.max(1, Math.min(page - 1, totalPages - 2));
  const end = Math.min(totalPages, start + 2);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatChange(value: number): string {
  const percentage = Math.round(value * 100);
  return `${percentage >= 0 ? '↑' : '↓'} ${Math.abs(percentage)}%`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  return fallback;
}
