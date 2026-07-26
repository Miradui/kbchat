import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Grid2X2, List, Plus, Star } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

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
import { Button } from '../../components/ui/Button';
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
import { formatMetricComparison } from './statsFormatting';
import {
  KnowledgeBaseFormDrawer,
  KnowledgeBaseRecycleBinDrawer,
} from './KnowledgeBaseDrawers';
import type { KnowledgeBaseFormState } from './KnowledgeBaseDrawers';

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

type FormState = KnowledgeBaseFormState;

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
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<KnowledgeBase[]>([]);
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [tags, setTags] = useState<KnowledgeBaseTag[]>([]);
  const [stats, setStats] = useState<KnowledgeBaseStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');
  const [preference, setPreference] = useState<KnowledgeBaseWorkspacePreference>(defaultPreference);
  const [recycleItems, setRecycleItems] = useState<RecycleBinItem[]>([]);
  const [recycleCount, setRecycleCount] = useState(0);
  const [recycleCountKnown, setRecycleCountKnown] = useState(false);
  const [recycleLoading, setRecycleLoading] = useState(false);
  const [recycleError, setRecycleError] = useState('');
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
  const [favoriteWorkingId, setFavoriteWorkingId] = useState<string | null>(null);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [error, setError] = useState('');
  const [bootstrapError, setBootstrapError] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const [preferenceError, setPreferenceError] = useState('');
  const workspaceRequestRef = useRef(0);
  const recycleRequestRef = useRef(0);
  const bootstrapRequestRef = useRef(0);
  const categoryRequestRef = useRef(0);
  const statsRequestRef = useRef(0);
  const workspaceMutationRef = useRef<symbol | null>(null);
  const preferenceOperationRef = useRef<symbol | null>(null);
  const preferenceRef = useRef(defaultPreference);
  const confirmedPreferenceRef = useRef(defaultPreference);
  const preferenceSaveInFlightRef = useRef(false);
  const pendingPreferenceRef = useRef<KnowledgeBaseWorkspacePreference | null>(null);
  const mountedRef = useRef(false);

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
  const resourceMutationBusy = submitting || Boolean(workingId) || Boolean(favoriteWorkingId);
  const workspaceMutationBusy = resourceMutationBusy || preferenceSaving;

  const loadRecycleBin = useCallback(async () => {
    const request = ++recycleRequestRef.current;
    setRecycleLoading(true);
    setRecycleError('');
    try {
      const response = await listKnowledgeBaseRecycleBin(1, 20);
      if (recycleRequestRef.current === request) {
        setRecycleItems(response.items);
        setRecycleCount(response.total);
        setRecycleCountKnown(true);
      }
    } catch (err) {
      if (recycleRequestRef.current === request) {
        setRecycleError(errorMessage(err, '知识库回收站加载失败'));
      }
    } finally {
      if (recycleRequestRef.current === request) {
        setRecycleLoading(false);
      }
    }
  }, []);

  const loadStats = useCallback(async () => {
    const request = ++statsRequestRef.current;
    setStatsLoading(true);
    setStatsError('');
    try {
      const response = await getKnowledgeBaseStats('month');
      if (statsRequestRef.current === request) {
        setStats(response);
      }
    } catch (err) {
      if (statsRequestRef.current === request) {
        setStatsError(errorMessage(err, '知识库统计加载失败'));
      }
    } finally {
      if (statsRequestRef.current === request) {
        setStatsLoading(false);
      }
    }
  }, []);

  const loadBootstrap = useCallback(async () => {
    const request = ++bootstrapRequestRef.current;
    const categoryRequest = ++categoryRequestRef.current;
    const recycleRequest = ++recycleRequestRef.current;
    setBootstrapping(true);
    setBootstrapError('');
    try {
      const [pref, categoryResponse, tagResponse, recycleResponse] = await Promise.all([
        getWorkspacePreference().catch(() => defaultPreference),
        listKnowledgeBaseCategories(),
        listKnowledgeBaseTags().catch(() => ({ items: [] })),
        listKnowledgeBaseRecycleBin(1, 20).catch(() => null),
      ]);
      if (bootstrapRequestRef.current !== request) {
        return;
      }
      preferenceRef.current = pref;
      confirmedPreferenceRef.current = pref;
      setPreference(pref);
      if (categoryRequestRef.current === categoryRequest) {
        setCategories(categoryResponse.items);
      }
      setTags(tagResponse.items);
      if (recycleResponse && recycleRequestRef.current === recycleRequest) {
        setRecycleItems(recycleResponse.items);
        setRecycleCount(recycleResponse.total);
        setRecycleCountKnown(true);
      }
    } catch (err) {
      if (bootstrapRequestRef.current === request) {
        setBootstrapError(errorMessage(err, '工作台初始化失败'));
      }
    } finally {
      if (bootstrapRequestRef.current === request) {
        setBootstrapping(false);
      }
    }
  }, []);

  const reloadCategories = useCallback(async () => {
    const request = ++categoryRequestRef.current;
    const response = await listKnowledgeBaseCategories();
    if (!mountedRef.current || categoryRequestRef.current !== request) {
      return null;
    }
    setCategories(response.items);
    return response.items;
  }, []);

  const loadWorkspace = useCallback(async () => {
    const request = ++workspaceRequestRef.current;
    setLoading(true);
    setWorkspaceError('');

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
      if (workspaceRequestRef.current === request) {
        setItems(response.items);
        setTotal(response.total ?? response.items.length);
        setSelectedIds((current) =>
          current.filter((id) => response.items.some((item) => item.id === id)),
        );
      }
    } catch (err) {
      if (workspaceRequestRef.current === request) {
        setWorkspaceError(errorMessage(err, '知识库加载失败'));
      }
    } finally {
      if (workspaceRequestRef.current === request) {
        setLoading(false);
      }
    }
  }, [categoryFilter, page, pageSize, preference.scope, preference.sort, preference.visibility, query, tagFilter]);

  useEffect(() => {
    if (searchParams.get('intent') !== 'create') {
      return;
    }

    openCreateForm();
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('intent');
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    mountedRef.current = true;
    void loadBootstrap();
    void loadStats();

    return () => {
      mountedRef.current = false;
      bootstrapRequestRef.current += 1;
      categoryRequestRef.current += 1;
      statsRequestRef.current += 1;
      workspaceRequestRef.current += 1;
      recycleRequestRef.current += 1;
      workspaceMutationRef.current = null;
      preferenceOperationRef.current = null;
      pendingPreferenceRef.current = null;
    };
  }, [loadBootstrap, loadStats]);

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

  async function flushPreferenceQueue() {
    if (preferenceSaveInFlightRef.current || !pendingPreferenceRef.current) {
      return;
    }

    let operation = preferenceOperationRef.current;
    if (!operation) {
      if (workspaceMutationRef.current) {
        return;
      }
      operation = Symbol('save-workspace-preference');
      preferenceOperationRef.current = operation;
      workspaceMutationRef.current = operation;
      setPreferenceSaving(true);
    }

    const next = pendingPreferenceRef.current;
    pendingPreferenceRef.current = null;
    preferenceSaveInFlightRef.current = true;
    try {
      const saved = await updateWorkspacePreference(next);
      if (!mountedRef.current || preferenceOperationRef.current !== operation) {
        return;
      }
      confirmedPreferenceRef.current = saved;
      setPreferenceError('');
      if (!pendingPreferenceRef.current) {
        preferenceRef.current = saved;
        setPreference(saved);
      }
    } catch (err) {
      if (!mountedRef.current || preferenceOperationRef.current !== operation) {
        return;
      }
      setPreferenceError(errorMessage(err, '工作台偏好保存失败'));
      if (!pendingPreferenceRef.current) {
        preferenceRef.current = confirmedPreferenceRef.current;
        setPreference(confirmedPreferenceRef.current);
      }
    } finally {
      preferenceSaveInFlightRef.current = false;
      if (!mountedRef.current || preferenceOperationRef.current !== operation) {
        return;
      }
      if (pendingPreferenceRef.current) {
        void flushPreferenceQueue();
      } else if (preferenceOperationRef.current === operation) {
        preferenceOperationRef.current = null;
        if (workspaceMutationRef.current === operation) {
          workspaceMutationRef.current = null;
        }
        setPreferenceSaving(false);
      }
    }
  }

  function persistPreference(next: KnowledgeBaseWorkspacePreference): boolean {
    if (
      workspaceMutationRef.current
      && workspaceMutationRef.current !== preferenceOperationRef.current
    ) {
      return false;
    }
    preferenceRef.current = next;
    pendingPreferenceRef.current = next;
    setPreference(next);
    void flushPreferenceQueue();
    return true;
  }

  function updateScope(scope: KnowledgeBaseScope) {
    if (persistPreference({ ...preferenceRef.current, scope })) {
      setPage(1);
    }
  }

  function updateVisibility(visibility: WorkspaceVisibility) {
    if (persistPreference({ ...preferenceRef.current, visibility })) {
      setPage(1);
    }
  }

  function updateSort(sort: KnowledgeBaseSort) {
    if (persistPreference({ ...preferenceRef.current, sort })) {
      setPage(1);
    }
  }

  function updateViewMode(viewMode: WorkspaceViewMode) {
    persistPreference({ ...preferenceRef.current, viewMode });
  }

  function toggleCategoryExpanded(categoryId: string) {
    if (
      workspaceMutationRef.current
      && workspaceMutationRef.current !== preferenceOperationRef.current
    ) {
      return;
    }
    const expanded = new Set(preferenceRef.current.expandedCategoryIds);
    if (expanded.has(categoryId)) {
      expanded.delete(categoryId);
    } else {
      expanded.add(categoryId);
    }
    persistPreference({ ...preferenceRef.current, expandedCategoryIds: Array.from(expanded) });
  }

  function openCreateCategory(parentId = '') {
    if (workspaceMutationRef.current) {
      return;
    }
    setCategoryForm({
      name: '',
      parentId,
      sortOrder: nextCategorySortOrder(categories, parentId || null),
    });
  }

  function openEditCategory(category: KnowledgeBaseCategory) {
    if (workspaceMutationRef.current) {
      return;
    }
    setCategoryForm({
      id: category.id,
      name: category.name,
      parentId: category.parentId ?? '',
      sortOrder: category.sortOrder,
    });
  }

  async function handleCategorySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!categoryForm || workspaceMutationRef.current) {
      return;
    }

    const operation = Symbol('save-knowledge-base-category');
    workspaceMutationRef.current = operation;
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
      if (workspaceMutationRef.current === operation) {
        setCategoryForm(null);
        await reloadCategories();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '分类保存失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  async function handleCategoryDelete() {
    if (!categoryDeleteTarget || workspaceMutationRef.current) {
      return;
    }

    const operation = Symbol('delete-knowledge-base-category');
    workspaceMutationRef.current = operation;
    setSubmitting(true);
    setError('');

    try {
      await deleteKnowledgeBaseCategory(categoryDeleteTarget.id);
      if (workspaceMutationRef.current === operation) {
        if (categoryFilter === categoryDeleteTarget.id) {
          setCategoryFilter('');
        }
        setCategoryDeleteTarget(null);
        await reloadCategories();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '分类删除失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  async function moveCategory(categoryId: string, direction: 'up' | 'down') {
    if (workspaceMutationRef.current) {
      return;
    }
    const itemsForReorder = categoryReorderItemsAfterMove(categories, categoryId, direction);
    if (!itemsForReorder) {
      return;
    }

    const operation = Symbol('reorder-knowledge-base-categories');
    workspaceMutationRef.current = operation;
    setWorkingId(categoryId);
    setError('');

    try {
      await reorderKnowledgeBaseCategories(itemsForReorder);
      if (workspaceMutationRef.current === operation) {
        await reloadCategories();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '分类排序保存失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setWorkingId(null);
      }
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || workspaceMutationRef.current) {
      return;
    }

    const operation = Symbol('save-knowledge-base');
    workspaceMutationRef.current = operation;
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
        if (workspaceMutationRef.current === operation) {
          setForm(null);
          setFormError('');
          await refreshAfterMutation();
        }
      } else {
        const created = await createKnowledgeBase(input);
        if (workspaceMutationRef.current === operation) {
          setForm(null);
          setFormError('');
          navigate(`/knowledge-bases/${encodeURIComponent(created.id)}/documents?intent=upload`);
        }
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setFormError(errorMessage(err, '知识库保存失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  async function handleDelete() {
    if (!deleteTarget || workspaceMutationRef.current) {
      return;
    }

    const operation = Symbol('delete-knowledge-bases');
    workspaceMutationRef.current = operation;
    setSubmitting(true);
    setError('');

    try {
      if (deleteTarget.kind === 'single') {
        await deleteKnowledgeBase(deleteTarget.item.id);
      } else {
        await batchDeleteKnowledgeBases(deleteTarget.ids);
      }
      if (workspaceMutationRef.current === operation) {
        setDeleteTarget(null);
        await refreshAfterMutation();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '知识库删除失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  async function refreshAfterMutation() {
    await Promise.all([
      loadStats(),
      loadRecycleBin(),
      loadWorkspace(),
    ]);
  }

  async function handleRestoreRecycleItem(item: RecycleBinItem) {
    if (workspaceMutationRef.current) {
      return;
    }
    const operation = Symbol('restore-knowledge-base');
    workspaceMutationRef.current = operation;
    setWorkingId(item.id);
    setError('');

    try {
      await restoreKnowledgeBase(item.id);
      if (workspaceMutationRef.current === operation) {
        await refreshAfterMutation();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '知识库恢复失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setWorkingId(null);
      }
    }
  }

  async function handleRestoreAllRecycleItems() {
    const ids = recycleItems.map((item) => item.id);
    if (ids.length === 0 || workspaceMutationRef.current) {
      return;
    }

    const operation = Symbol('restore-all-knowledge-bases');
    workspaceMutationRef.current = operation;
    setSubmitting(true);
    setError('');

    try {
      await batchRestoreKnowledgeBases(ids);
      if (workspaceMutationRef.current === operation) {
        await refreshAfterMutation();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '批量恢复失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  async function handlePermanentDeleteKnowledgeBase() {
    if (!permanentDeleteTarget || workspaceMutationRef.current) {
      return;
    }

    const operation = Symbol('permanently-delete-knowledge-base');
    workspaceMutationRef.current = operation;
    setSubmitting(true);
    setError('');

    try {
      await deleteKnowledgeBasePermanently(permanentDeleteTarget.id);
      if (workspaceMutationRef.current === operation) {
        setPermanentDeleteTarget(null);
        await refreshAfterMutation();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '知识库永久删除失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  async function handleEmptyKnowledgeBaseRecycleBin() {
    if (workspaceMutationRef.current) {
      return;
    }
    const operation = Symbol('empty-knowledge-base-recycle-bin');
    workspaceMutationRef.current = operation;
    setSubmitting(true);
    setError('');

    try {
      await emptyKnowledgeBaseRecycleBin();
      if (workspaceMutationRef.current === operation) {
        setConfirmEmptyRecycleBin(false);
        await refreshAfterMutation();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '清空失败，未删除任何知识库。'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  async function toggleFavorite(item: KnowledgeBase) {
    if (workspaceMutationRef.current) {
      return;
    }
    const operation = Symbol('favorite-knowledge-base');
    workspaceMutationRef.current = operation;
    setFavoriteWorkingId(item.id);
    setError('');

    try {
      if (item.isFavorite) {
        await unfavoriteKnowledgeBase(item.id);
      } else {
        await favoriteKnowledgeBase(item.id);
      }
      if (workspaceMutationRef.current === operation) {
        await loadWorkspace();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '收藏状态更新失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setFavoriteWorkingId(null);
      }
    }
  }

  async function handleBatchFavorite(favorite: boolean) {
    if (selectedIds.length === 0 || workspaceMutationRef.current) {
      return;
    }
    const operation = Symbol('batch-favorite-knowledge-bases');
    workspaceMutationRef.current = operation;
    setFavoriteWorkingId('batch');
    setSubmitting(true);
    setError('');
    try {
      await batchFavoriteKnowledgeBases(selectedIds, favorite);
      if (workspaceMutationRef.current === operation) {
        await loadWorkspace();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '批量收藏更新失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setFavoriteWorkingId(null);
        setSubmitting(false);
      }
    }
  }

  async function handleBatchMoveCategory() {
    if (selectedIds.length === 0 || workspaceMutationRef.current) {
      return;
    }

    const operation = Symbol('move-knowledge-bases');
    workspaceMutationRef.current = operation;
    setSubmitting(true);
    setError('');

    try {
      await batchMoveKnowledgeBases(selectedIds, bulkCategoryId || null);
      if (workspaceMutationRef.current === operation) {
        setSelectedIds([]);
        await refreshAfterMutation();
      }
    } catch (err) {
      if (workspaceMutationRef.current === operation) {
        setError(errorMessage(err, '批量移动分类失败'));
      }
    } finally {
      if (workspaceMutationRef.current === operation) {
        workspaceMutationRef.current = null;
        setSubmitting(false);
      }
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
    if (workspaceMutationRef.current) {
      return;
    }
    setFormError('');
    setForm(emptyForm);
  }

  function openEditForm(item: KnowledgeBase) {
    if (workspaceMutationRef.current) {
      return;
    }
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

  function selectCategory(categoryId: string) {
    if (workspaceMutationRef.current) {
      return;
    }
    setCategoryFilter((current) => (current === categoryId ? '' : categoryId));
    setPage(1);
  }

  function handleScopeKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % scopeTabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + scopeTabs.length) % scopeTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = scopeTabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const target = event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex];
    target?.focus();
    updateScope(scopeTabs[nextIndex].value);
  }

  function handleOpenKnowledgeBase(item: KnowledgeBase): boolean {
    if (workspaceMutationRef.current) {
      return false;
    }
    recordKnowledgeBaseView(item.id).catch(() => undefined);
    return true;
  }

  function openRecycleBin() {
    if (workspaceMutationRef.current) {
      return;
    }
    setShowRecycleBin(true);
    void loadRecycleBin();
  }

  function openKnowledgeBaseDelete(target: DeleteTarget) {
    if (workspaceMutationRef.current) {
      return;
    }
    setError('');
    setDeleteTarget(target);
  }

  const allVisibleSelected = items.length > 0 && items.every((item) => selectedSet.has(item.id));
  const listRefreshing = loading && !bootstrapping && items.length > 0;

  return (
    <WorkspaceShell
      active="knowledge-bases"
      categories={categories}
      categoryFilter={categoryFilter}
      expandedIds={preference.expandedCategoryIds}
      categoryBusy={resourceMutationBusy}
      categoryWorkingId={workingId}
      onCreateCategory={openCreateCategory}
      onDeleteCategory={(category) => {
        if (!workspaceMutationRef.current) {
          setError('');
          setCategoryDeleteTarget(category);
        }
      }}
      onEditCategory={openEditCategory}
      onMoveCategory={moveCategory}
      onSelectCategory={selectCategory}
      onToggleExpanded={toggleCategoryExpanded}
    >
      <section aria-busy={workspaceMutationBusy} aria-label="知识库工作区">
          {workspaceMutationBusy && (
            <p aria-label="正在处理工作区操作" className="sr-only" role="status">
              正在处理工作区操作，请稍候。
            </p>
          )}
          <header className="page-header workspace-heading">
            <div>
              <h1>知识库</h1>
              <p className="page-description">集中管理和组织您的知识资产，构建企业智慧大脑</p>
            </div>
            <div className="toolbar">
              <Link
                aria-disabled={workspaceMutationBusy || undefined}
                className="secondary-link"
                tabIndex={workspaceMutationBusy ? -1 : undefined}
                to={items[0] ? `/knowledge-bases/${items[0].id}/documents` : '/documents'}
                onClick={(event) => {
                  if (workspaceMutationRef.current) {
                    event.preventDefault();
                  }
                }}
              >
                导入文档
              </Link>
              <button
                className="secondary-button"
                type="button"
                onClick={openRecycleBin}
                disabled={workspaceMutationBusy}
              >
                回收站 {recycleCountKnown ? recycleCount : '--'}
              </button>
              <Button disabled={workspaceMutationBusy} leadingIcon={<Plus aria-hidden="true" />} onClick={openCreateForm}>
                新建知识库
              </Button>
            </div>
          </header>

          <StatsGrid
            error={statsError}
            fallbackTotal={!loading && !workspaceError ? total : null}
            loading={statsLoading}
            onRetry={() => void loadStats()}
            stats={stats}
          />

          <div className="workspace-tabs" role="tablist" aria-label="知识库范围">
            {scopeTabs.map((tab, index) => (
              <button
                aria-controls="knowledge-base-scope-panel"
                aria-selected={preference.scope === tab.value}
                className={preference.scope === tab.value ? 'workspace-tab active' : 'workspace-tab'}
                disabled={resourceMutationBusy}
                id={`knowledge-base-scope-${tab.value}`}
                key={tab.value}
                role="tab"
                tabIndex={preference.scope === tab.value ? 0 : -1}
                type="button"
                onClick={() => updateScope(tab.value)}
                onKeyDown={(event) => handleScopeKeyDown(event, index)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="workspace-controls">
            <select
              aria-label="知识库可见性"
              disabled={resourceMutationBusy}
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
                disabled={resourceMutationBusy}
                value={preference.sort}
                onChange={(event) => updateSort(event.target.value as KnowledgeBaseSort)}
              >
                <option value="updatedAt_desc">最新更新</option>
                <option value="createdAt_desc">最新创建</option>
                <option value="name_asc">名称升序</option>
              </select>
              <div className="segmented-control" aria-label="视图模式" role="group">
                <button
                  aria-pressed={preference.viewMode === 'card'}
                  className={preference.viewMode === 'card' ? 'active' : ''}
                  disabled={resourceMutationBusy}
                  type="button"
                  onClick={() => updateViewMode('card')}
                  aria-label="卡片视图"
                >
                  <Grid2X2 aria-hidden="true" />
                </button>
                <button
                  aria-pressed={preference.viewMode === 'table'}
                  className={preference.viewMode === 'table' ? 'active' : ''}
                  disabled={resourceMutationBusy}
                  type="button"
                  onClick={() => updateViewMode('table')}
                  aria-label="列表视图"
                >
                  <List aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          {selectedIds.length > 0 && (
            <div className="bulk-bar">
              <span>已选择 {selectedIds.length} 项</span>
              <button className="secondary-button" type="button" onClick={() => void handleBatchFavorite(true)} disabled={workspaceMutationBusy}>
                批量收藏
              </button>
              <button className="secondary-button" type="button" onClick={() => void handleBatchFavorite(false)} disabled={workspaceMutationBusy}>
                取消收藏
              </button>
              <label className="inline-select bulk-category-select">
                移动到
                <select
                  value={bulkCategoryId}
                  onChange={(event) => setBulkCategoryId(event.target.value)}
                  disabled={workspaceMutationBusy}
                >
                  <option value="">未分类</option>
                  {flatCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="secondary-button" type="button" onClick={() => void handleBatchMoveCategory()} disabled={workspaceMutationBusy}>
                移动分类
              </button>
              <button className="danger-button" type="button" onClick={() => openKnowledgeBaseDelete({ kind: 'batch', ids: selectedIds })} disabled={workspaceMutationBusy}>
                批量删除
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={openRecycleBin}
                disabled={workspaceMutationBusy}
              >
                回收站 {recycleCountKnown ? recycleCount : '--'}
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

          {error && <p className="error-text" role="alert">{error}</p>}
          {preferenceError && <p className="error-text" role="alert">{preferenceError}</p>}
          {bootstrapError && items.length > 0 && (
            <div className="error-text" role="alert">
              <span>{bootstrapError}</span>
              <button className="link-button" type="button" onClick={() => void loadBootstrap()}>
                重试初始化
              </button>
            </div>
          )}

          <div
            aria-labelledby={`knowledge-base-scope-${preference.scope}`}
            className={listRefreshing ? 'workspace-list-panel is-refreshing' : 'workspace-list-panel'}
            id="knowledge-base-scope-panel"
            role="tabpanel"
          >
            {(loading || bootstrapping) && items.length === 0 ? (
              <LoadingSkeleton rows={6} columns={5} announce />
            ) : workspaceError ? (
              <div className="empty-state" role="alert">
                <p>{workspaceError}</p>
                <button className="secondary-button" type="button" onClick={() => void loadWorkspace()}>
                  重试知识库列表
                </button>
              </div>
            ) : bootstrapError && items.length === 0 ? (
              <div className="empty-state" role="alert">
                <p>{bootstrapError}</p>
                <button className="secondary-button" type="button" onClick={() => void loadBootstrap()}>
                  重试初始化
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="empty-state">
                当前筛选下没有知识库。可以调整分类和范围，或新建一个知识库开始整理资料。
              </div>
            ) : preference.viewMode === 'card' ? (
              <KnowledgeBaseCards
                items={items}
                selectedSet={selectedSet}
                working={workspaceMutationBusy}
                onDelete={(item) => openKnowledgeBaseDelete({ kind: 'single', item })}
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
                working={workspaceMutationBusy}
                onDelete={(item) => openKnowledgeBaseDelete({ kind: 'single', item })}
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
              <button aria-label="上一页" className="secondary-button" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                <ChevronLeft aria-hidden="true" />
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
              <button aria-label="下一页" className="secondary-button" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                <ChevronRight aria-hidden="true" />
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
      </section>
      {showRecycleBin && (
        <KnowledgeBaseRecycleBinDrawer
          busy={workspaceMutationBusy}
          error={recycleError}
          items={recycleItems}
          loading={recycleLoading}
          workingId={workingId}
          onClose={() => setShowRecycleBin(false)}
          onRefresh={() => void loadRecycleBin()}
          onDeletePermanently={(item) => { setError(''); setPermanentDeleteTarget(item); }}
          onEmpty={() => { setError(''); setConfirmEmptyRecycleBin(true); }}
          onRestore={handleRestoreRecycleItem}
          onRestoreAll={handleRestoreAllRecycleItems}
        />
      )}

      {form && (
        <KnowledgeBaseFormDrawer
          busy={workspaceMutationBusy}
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
          description={`确认删除“${categoryDeleteTarget.name}”？包含子分类或知识库的分类无法删除。`}
          confirmLabel="删除"
          busy={workspaceMutationBusy}
          error={error}
          onCancel={() => { setError(''); setCategoryDeleteTarget(null); }}
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
          busy={workspaceMutationBusy}
          error={error}
          onCancel={() => { setError(''); setDeleteTarget(null); }}
          onConfirm={handleDelete}
        />
      )}

      {permanentDeleteTarget && (
        <ConfirmDialog
          title="永久删除知识库"
          description={`确认永久删除“${permanentDeleteTarget.name}”？关联文档、内容片段、会话和成员等数据会被清理，且不可恢复。`}
          confirmLabel="永久删除"
          busy={workspaceMutationBusy}
          error={error}
          onCancel={() => { setError(''); setPermanentDeleteTarget(null); }}
          onConfirm={handlePermanentDeleteKnowledgeBase}
        />
      )}

      {confirmEmptyRecycleBin && (
        <ConfirmDialog
          title="清空知识库回收站"
          description="确认清空知识库回收站？操作失败时不会删除其中任何知识库。"
          confirmLabel="清空"
          busy={workspaceMutationBusy}
          error={error}
          onCancel={() => { setError(''); setConfirmEmptyRecycleBin(false); }}
          onConfirm={handleEmptyKnowledgeBaseRecycleBin}
        />
      )}
    </WorkspaceShell>
  );
}

function StatsGrid({
  error,
  fallbackTotal,
  loading,
  onRetry,
  stats,
}: {
  error: string;
  fallbackTotal: number | null;
  loading: boolean;
  onRetry: () => void;
  stats: KnowledgeBaseStatsResponse | null;
}) {
  const cards = [
    { label: '知识库总数', metric: stats?.knowledgeBases, fallback: fallbackTotal, unit: '个', tone: 'blue' },
    { label: '文档总数', metric: stats?.documents, fallback: null, unit: '篇', tone: 'green' },
    { label: '总浏览量', metric: stats?.views, fallback: null, unit: '次', tone: 'violet' },
    { label: '问答总数', metric: stats?.questions, fallback: null, unit: '条', tone: 'orange' },
  ];

  return (
    <>
      <div className="workspace-stats">
        {cards.map((card) => {
          const value = card.metric?.value ?? card.fallback;
          return (
            <article className="workspace-stat-card" key={card.label}>
              <span className={`stat-icon ${card.tone}`} aria-hidden="true" />
              <div>
                <span>{card.label}</span>
                <strong>
                  {value === null ? '--' : formatNumber(value)}
                  <small>{card.unit}</small>
                </strong>
                <em>
                  {card.metric
                    ? formatMetricComparison(card.metric, stats?.period ?? 'month')
                    : loading
                      ? '统计加载中'
                      : '暂无可比数据'}
                </em>
              </div>
            </article>
          );
        })}
      </div>
      {error && (
        <div className="error-text" role="alert">
          <span>{error}</span>
          <button className="link-button" type="button" onClick={onRetry}>
            重试统计
          </button>
        </div>
      )}
    </>
  );
}

function KnowledgeBaseTable({
  allVisibleSelected,
  items,
  selectedSet,
  working,
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
  working: boolean;
  onDelete: (item: KnowledgeBase) => void;
  onEdit: (item: KnowledgeBase) => void;
  onFavorite: (item: KnowledgeBase) => void;
  onOpen: (item: KnowledgeBase) => boolean;
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
                <Link
                  aria-disabled={working || undefined}
                  className="kb-name-cell"
                  tabIndex={working ? -1 : undefined}
                  to={`/knowledge-bases/${item.id}`}
                  onClick={(event) => {
                    if (!onOpen(item)) {
                      event.preventDefault();
                    }
                  }}
                >
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
              <td data-label="文档数">{formatOptionalCount(item.documentCount)}</td>
              <td data-label="更新人">
                <UserCell user={item.updatedBy} />
              </td>
              <td data-label="更新时间">{formatDateTime(item.updatedAt || item.createdAt)}</td>
              <td data-label="操作">
                <RowActions
                  item={item}
                  working={working}
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
  working,
  onDelete,
  onEdit,
  onFavorite,
  onOpen,
  onToggleSelected,
}: {
  items: KnowledgeBase[];
  selectedSet: Set<string>;
  working: boolean;
  onDelete: (item: KnowledgeBase) => void;
  onEdit: (item: KnowledgeBase) => void;
  onFavorite: (item: KnowledgeBase) => void;
  onOpen: (item: KnowledgeBase) => boolean;
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
              working={working}
              onDelete={onDelete}
              onEdit={onEdit}
              onFavorite={onFavorite}
            />
          </header>
          <Link
            aria-disabled={working || undefined}
            tabIndex={working ? -1 : undefined}
            to={`/knowledge-bases/${item.id}`}
            onClick={(event) => {
              if (!onOpen(item)) {
                event.preventDefault();
              }
            }}
          >
            <strong>{item.name}</strong>
            <p>{item.description || '未填写描述'}</p>
          </Link>
          <div className="kb-card-meta">
            <span>{formatOptionalCount(item.documentCount)} 文档</span>
            <span>{formatOptionalCount(item.viewCount)} 浏览</span>
            <span>{formatOptionalCount(item.questionCount)} 问答</span>
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
        <Star aria-hidden="true" fill={item.isFavorite ? 'currentColor' : 'none'} />
      </button>
      <button className="link-button" type="button" disabled={working} onClick={() => onEdit(item)}>
        编辑
      </button>
      <button className="link-button" type="button" disabled={working} onClick={() => onDelete(item)}>
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

function formatOptionalCount(value: number | null | undefined): string {
  return typeof value === 'number' ? String(value) : '--';
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
