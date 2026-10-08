import { FolderInput, Plus, Star, Tags, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import {
  batchDeleteKnowledgeBases,
  batchFavoriteKnowledgeBases,
  batchMoveKnowledgeBases,
  batchTagKnowledgeBases,
  createKnowledgeBase,
  deleteKnowledgeBase,
  favoriteKnowledgeBase,
  listKnowledgeBaseRecycleBin,
  listKnowledgeBaseTags,
  recordKnowledgeBaseView,
  unfavoriteKnowledgeBase,
  updateKnowledgeBase,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import { MetricStrip } from '../../components/ui/MetricStrip';
import { Pagination } from '../../components/ui/Pagination';
import { Checkbox } from '../../components/ui/Field';
import { useEntityMutation } from '../../hooks/useEntityMutation';
import { PageHeading } from '../../components/ui/PageHeading';
import { AppShell } from '../../layouts/AppShell';
import type {
  KnowledgeBase,
  KnowledgeBaseBatchTagMode,
  KnowledgeBaseTag,
  RetrievalConfig,
} from '../../types/api';
import { canUnlessUnknown } from '../../utils/access';
import { getErrorMessage } from '../../utils/errors';
import { CategoryPanel } from './CategoryPanel';
import { KnowledgeBaseCards, KnowledgeBaseTable } from './KnowledgeBaseList';
import type { RowHandlers } from './KnowledgeBaseList';
import { KnowledgeBaseFormDialog } from './KnowledgeBaseFormDialog';
import type { KnowledgeBaseFormState } from './KnowledgeBaseFormDialog';
import { KnowledgeBaseMoveDialog } from './KnowledgeBaseMoveDialog';
import { KnowledgeBaseBatchDialog, type KnowledgeBaseBatchChange } from './KnowledgeBaseBatchDialog';
import { KnowledgeBaseRecycleBinDrawer } from './KnowledgeBaseRecycleBinDrawer';
import { KnowledgeBaseToolbar } from './KnowledgeBaseToolbar';
import { flattenCategories } from './categoryTreeUtils';
import { getKnowledgeBaseReadiness } from './knowledgeBaseReadiness';
import { useCategories } from './useCategories';
import { useKnowledgeBaseList } from './useKnowledgeBaseList';

const defaultRetrievalConfig: RetrievalConfig = {
  vectorTopN: 30,
  rerankTopK: 5,
  scoreThreshold: 0.3,
  enableRerank: true,
  enableKeyword: true,
};

const emptyForm: KnowledgeBaseFormState = {
  name: '',
  description: '',
  categoryId: '',
  visibility: 'private',
  tagIds: [],
};

type DeleteTarget = { kind: 'single'; item: KnowledgeBase } | { kind: 'batch'; ids: string[] };

const bulkTagFeedback: Record<KnowledgeBaseBatchTagMode, { success: string; failure: string }> = {
  add: { success: '已批量添加标签', failure: '批量添加标签失败' },
  remove: { success: '已批量移除标签', failure: '批量移除标签失败' },
  replace: { success: '已批量替换标签', failure: '批量替换标签失败' },
};

export function KnowledgeBaseListPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const list = useKnowledgeBaseList();
  const categories = useCategories();
  const mutation = useEntityMutation();

  const [tags, setTags] = useState<KnowledgeBaseTag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [tagsError, setTagsError] = useState('');
  const tagsRequestRef = useRef(0);
  const [recycleCount, setRecycleCount] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchTarget, setBatchTarget] = useState<{ kind: 'move' | 'tags'; ids: string[] } | null>(null);
  const [batchError, setBatchError] = useState('');
  const [form, setForm] = useState<KnowledgeBaseFormState | null>(null);
  const [formError, setFormError] = useState('');
  const [moveTarget, setMoveTarget] = useState<KnowledgeBase | null>(null);
  const [moveCategoryId, setMoveCategoryId] = useState('');
  const [moveError, setMoveError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [recycleOpen, setRecycleOpen] = useState(false);
  const openedCreateRef = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const focusResultsRef = useRef(false);

  useEffect(() => {
    if (focusResultsRef.current && !batchTarget && !deleteTarget) {
      focusResultsRef.current = false;
      resultsRef.current?.focus();
    }
  }, [selectedIds, batchTarget, deleteTarget]);

  const { items, total, loading, error, filters, activeFilterCount, viewMode, reload, setFilter } = list;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  // The batch endpoints are all-or-nothing: one id the caller cannot touch fails the
  // whole call. So a bulk control appears only when every selected base permits it,
  // and the notice below says why the rest are missing.
  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  );
  const canBulkWrite = selectedItems.length > 0
    && selectedItems.every((item) => canUnlessUnknown(item, 'kb.write'));
  const canBulkDelete = selectedItems.length > 0
    && selectedItems.every((item) => canUnlessUnknown(item, 'kb.delete'));
  const categoryOptions = useMemo(() => flattenCategories(categories.categories), [categories.categories]);

  const refreshRecycleCount = useCallback(() => {
    void listKnowledgeBaseRecycleBin(1, 1)
      .then((response) => setRecycleCount(response.total))
      .catch(() => setRecycleCount(null));
  }, []);

  const loadTags = useCallback(async () => {
    const request = ++tagsRequestRef.current;
    setTagsLoading(true);
    try {
      const response = await listKnowledgeBaseTags();
      if (request !== tagsRequestRef.current) return;
      setTags(response.items);
      setTagsError('');
    } catch (caught) {
      if (request === tagsRequestRef.current) setTagsError(getErrorMessage(caught, '标签加载失败'));
    } finally {
      if (request === tagsRequestRef.current) setTagsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTags();
    refreshRecycleCount();
    return () => { tagsRequestRef.current += 1; };
  }, [loadTags, refreshRecycleCount]);

  // Drop selections for rows that are no longer on screen.
  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => items.some((item) => item.id === id)));
  }, [items]);

  const openCreate = useCallback(() => {
    setFormError('');
    setForm({ ...emptyForm, tagIds: [] });
  }, []);

  // `/knowledge-bases?intent=create` opens the dialog once, then drops the param.
  useEffect(() => {
    if (searchParams.get('intent') !== 'create' || openedCreateRef.current) return;
    openedCreateRef.current = true;
    openCreate();
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('intent');
      return next;
    }, { replace: true });
  }, [openCreate, searchParams, setSearchParams]);

  const counts = useMemo(() => {
    let failed = 0;
    let processing = 0;
    items.forEach((item) => {
      const readiness = getKnowledgeBaseReadiness(item);
      if (readiness.tone === 'danger') failed += 1;
      if (readiness.tone === 'warn') processing += 1;
    });
    return { failed, processing };
  }, [items]);

  async function withRefresh(key: string, action: () => Promise<void>, success: string, failure: string) {
    await mutation.run(key, async () => {
      try {
        await action();
        toast.success(success);
        await reload();
        refreshRecycleCount();
      } catch (caught) {
        toast.error(getErrorMessage(caught, failure));
      }
    });
  }

  function toggleFavorite(item: KnowledgeBase) {
    void mutation.run(item.id, async () => {
      try {
        if (item.isFavorite) await unfavoriteKnowledgeBase(item.id);
        else await favoriteKnowledgeBase(item.id);
        await reload();
      } catch (caught) {
        toast.error(getErrorMessage(caught, '收藏状态更新失败'));
      }
    });
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;

    const input = {
      name: form.name.trim(),
      description: form.description.trim(),
      categoryId: form.categoryId || null,
      visibility: form.visibility,
      retrievalConfig: form.id
        ? items.find((item) => item.id === form.id)?.retrievalConfig ?? defaultRetrievalConfig
        : defaultRetrievalConfig,
      tagIds: form.tagIds,
    };

    await mutation.run('form', async () => {
      setFormError('');
      try {
        if (form.id) {
          await updateKnowledgeBase(form.id, input);
          setForm(null);
          toast.success('知识库更新成功');
          await reload();
        } else {
          const created = await createKnowledgeBase(input);
          setForm(null);
          toast.success('知识库创建成功');
          navigate(`/knowledge-bases/${encodeURIComponent(created.id)}/documents?intent=upload`);
        }
      } catch (caught) {
        setFormError(getErrorMessage(caught, '知识库保存失败'));
      }
    });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await mutation.run('delete', async () => {
      setDeleteError('');
      try {
        if (deleteTarget.kind === 'single') await deleteKnowledgeBase(deleteTarget.item.id);
        else await batchDeleteKnowledgeBases(deleteTarget.ids);
        focusResultsRef.current = true;
        setDeleteTarget(null);
        setSelectedIds([]);
        toast.success(deleteTarget.kind === 'single' ? '知识库已移入回收站' : '所选知识库已移入回收站');
        await reload();
        refreshRecycleCount();
      } catch (caught) {
        setDeleteError(getErrorMessage(caught, '知识库删除失败'));
      }
    });
  }

  async function submitMove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!moveTarget) return;
    await mutation.run(moveTarget.id, async () => {
      setMoveError('');
      try {
        await batchMoveKnowledgeBases([moveTarget.id], moveCategoryId || null);
        setMoveTarget(null);
        toast.success('知识库移动成功');
        await reload();
      } catch (caught) {
        setMoveError(getErrorMessage(caught, '知识库移动失败'));
      }
    });
  }

  async function submitBatch(change: KnowledgeBaseBatchChange) {
    if (!batchTarget) return;
    const ids = batchTarget.ids;
    await mutation.run('bulk', async () => {
      setBatchError('');
      try {
        if (change.kind === 'move') await batchMoveKnowledgeBases(ids, change.categoryId);
        else await batchTagKnowledgeBases(ids, change.tagIds, change.mode);
        focusResultsRef.current = true;
        setBatchTarget(null);
        setSelectedIds(current => current.filter(id => !ids.includes(id)));
        toast.success(change.kind === 'move' ? `已移动 ${ids.length} 个知识库` : bulkTagFeedback[change.mode].success);
        void reload();
        if (change.kind === 'move') void categories.reload();
      } catch (caught) {
        setBatchError(getErrorMessage(caught, change.kind === 'move' ? '批量移动失败' : bulkTagFeedback[change.mode].failure));
      }
    });
  }

  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const allFavorited = selectedItems.length > 0 && selectedItems.every(item => item.isFavorite);
  const bulkBusy = mutation.isPending('bulk') || mutation.isPending('delete') || selectedItems.some(item => mutation.isPending(item.id));
  const busy = mutation.anyPending;

  const rowHandlers: RowHandlers = {
    isPending: (id) => mutation.isPending(id) || (bulkBusy && (batchTarget?.ids ?? selectedIds).includes(id)),
    onDelete: (item) => {
      setDeleteError('');
      setDeleteTarget({ kind: 'single', item });
    },
    onEdit: (item) => {
      setFormError('');
      setForm({
        id: item.id,
        name: item.name,
        description: item.description,
        categoryId: item.categoryId ?? '',
        visibility: item.visibility ?? 'private',
        tagIds: item.tags?.map((tag) => tag.id) ?? [],
      });
    },
    onFavorite: toggleFavorite,
    onMove: (item) => {
      setMoveError('');
      setMoveCategoryId(item.categoryId ?? '');
      setMoveTarget(item);
    },
    // Views are recorded explicitly; a failure here must not block navigation.
    onOpen: (item) => { void recordKnowledgeBaseView(item.id).catch(() => undefined); },
    onToggleSelected: (id) => setSelectedIds((current) => (
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    )),
  };

  return (
    <AppShell active="knowledge-bases" breadcrumbs={[{ label: '知识库' }]}>
      <PageHeading title="知识库" description="按主题整理资料，构建可以随时提问的知识空间。"
        actions={<Button leadingIcon={<Plus aria-hidden="true" />} onClick={openCreate}>新建知识库</Button>}
      />
      <div className="kb-page" aria-busy={busy || undefined}>
        <CategoryPanel
          controller={categories}
          expandedIds={list.expandedCategoryIds}
          onClear={() => setFilter({ categoryId: '' })}
          onSelect={(categoryId) => setFilter({ categoryId: filters.categoryId === categoryId ? '' : categoryId })}
          onToggleExpanded={list.toggleCategoryExpanded}
          selectedId={filters.categoryId}
          totalCount={activeFilterCount > 0 ? null : total}
        />

        <section className="kb-main">
          <KnowledgeBaseToolbar
            filters={filters}
            onFilter={setFilter}
            onOpenRecycleBin={() => setRecycleOpen(true)}
            onViewMode={list.changeViewMode}
            recycleCount={recycleCount}
            tags={tags}
            viewMode={viewMode}
          />

          <MetricStrip
            label="知识库概况"
            metrics={[
              { key: 'total', label: '个知识库', value: loading && items.length === 0 ? null : total },
              {
                key: 'processing',
                label: '个处理中',
                tone: 'warn',
                value: counts.processing,
              },
              {
                key: 'failed',
                label: '个存在失败',
                tone: 'danger',
                value: counts.failed,
              },
            ]}
            trailing={activeFilterCount > 0 ? (
              <Button
                variant="link"
                onClick={() => setFilter({ q: '', categoryId: '', tagId: '', visibility: 'all', scope: 'all' })}
              >
                清除 {activeFilterCount} 个筛选
              </Button>
            ) : undefined}
          />

          {viewMode === 'card' && items.length > 0 && !error && (
            <label className="kb-select-page">
              <Checkbox aria-label="选择当前页全部知识库" checked={allSelected} disabled={bulkBusy || loading}
                ref={element => { if (element) element.indeterminate = selectedIds.length > 0 && !allSelected; }}
                onChange={() => setSelectedIds(allSelected ? [] : items.map(item => item.id))} />
              选择当前页
            </label>
          )}
          {selectedIds.length > 0 && (
            <div className="ui-bulkbar" role="region" aria-label="知识库批量操作">
              <span className="ui-bulkbar__count">已选择 {selectedIds.length} 项</span>
              <Button disabled={bulkBusy} leadingIcon={<Star aria-hidden="true" />} variant="secondary"
                onClick={() => void withRefresh('bulk', async () => { await batchFavoriteKnowledgeBases([...selectedIds], !allFavorited); }, allFavorited ? '已取消收藏' : '已批量收藏', '收藏状态更新失败')}>
                {allFavorited ? '取消收藏' : '收藏'}
              </Button>
              {canBulkWrite && <>
                <Button disabled={bulkBusy} leadingIcon={<FolderInput aria-hidden="true" />} variant="secondary" onClick={() => { setBatchError(''); setBatchTarget({ kind: 'move', ids: [...selectedIds] }); }}>移动到分类</Button>
                <Button disabled={bulkBusy} leadingIcon={<Tags aria-hidden="true" />} variant="secondary" onClick={() => { setBatchError(''); setBatchTarget({ kind: 'tags', ids: [...selectedIds] }); }}>管理标签</Button>
              </>}
              {!canBulkWrite && <span className="ui-muted">部分所选知识库没有整理权限。</span>}
              <span className="ui-toolbar__spacer" />
              {canBulkDelete && <Button disabled={bulkBusy} leadingIcon={<Trash2 aria-hidden="true" />} variant="danger" onClick={() => { setDeleteError(''); setDeleteTarget({ kind: 'batch', ids: [...selectedIds] }); }}>删除</Button>}
              <Button disabled={bulkBusy} leadingIcon={<X aria-hidden="true" />} variant="ghost" onClick={() => { focusResultsRef.current = true; setSelectedIds([]); }}>取消选择</Button>
            </div>
          )}

          <div ref={resultsRef} role="region" aria-label="知识库列表" tabIndex={-1} className={`kb-results${viewMode === 'card' && items.length > 0 && !error ? ' kb-results--cards' : ''}${loading && items.length > 0 ? ' is-refreshing' : ''}`}>
            {loading && items.length === 0 ? (
              <LoadingSkeleton announce columns={5} rows={6} />
            ) : error ? (
              <ErrorState description={error} onRetry={() => void reload()} title="知识库加载失败" />
            ) : items.length === 0 ? (
              <EmptyState
                action={activeFilterCount > 0
                  ? (
                    <Button
                      variant="secondary"
                      onClick={() => setFilter({ q: '', categoryId: '', tagId: '', visibility: 'all', scope: 'all' })}
                    >
                      清除筛选
                    </Button>
                  )
                  : <Button onClick={openCreate}>新建知识库</Button>}
                description={activeFilterCount > 0
                  ? '调整筛选条件后再试，或清除全部筛选。'
                  : '创建知识库后即可导入文档并开始问答。'}
                title={activeFilterCount > 0 ? '没有匹配的知识库' : '还没有知识库'}
              />
            ) : viewMode === 'card' ? (
              <KnowledgeBaseCards handlers={rowHandlers} items={items} selected={selected} />
            ) : (
              <KnowledgeBaseTable
                allSelected={allSelected}
                handlers={rowHandlers}
                items={items}
                onToggleAll={() => setSelectedIds(allSelected ? [] : items.map((item) => item.id))}
                selected={selected}
              />
            )}
          </div>

          <Pagination
            onPageChange={(page) => setFilter({ page })}
            onPageSizeChange={(pageSize) => setFilter({ pageSize })}
            page={filters.page}
            pageSize={filters.pageSize}
            total={total}
          />
        </section>
      </div>

      {form && (
        <KnowledgeBaseFormDialog
          busy={mutation.isPending('form')}
          categories={categoryOptions}
          error={formError}
          form={form}
          onChange={(next) => {
            setForm(next);
            if (formError) setFormError('');
          }}
          onClose={() => {
            setForm(null);
            setFormError('');
          }}
          onSubmit={(event) => void submitForm(event)}
          tags={tags}
        />
      )}

      {moveTarget && (
        <KnowledgeBaseMoveDialog
          busy={mutation.isPending(moveTarget.id)}
          categories={categoryOptions}
          error={moveError}
          knowledgeBaseName={moveTarget.name}
          onChange={setMoveCategoryId}
          onClose={() => {
            setMoveTarget(null);
            setMoveError('');
          }}
          onSubmit={(event) => void submitMove(event)}
          targetCategoryId={moveCategoryId}
        />
      )}

      {batchTarget && (
        <KnowledgeBaseBatchDialog
          kind={batchTarget.kind} count={batchTarget.ids.length} busy={mutation.isPending('bulk')} error={batchError}
          categories={categoryOptions} tags={tags}
          optionsLoading={batchTarget.kind === 'move' ? categories.loading : tagsLoading}
          optionsError={batchTarget.kind === 'move' ? categories.error : tagsError}
          onRetryOptions={() => { if (batchTarget.kind === 'move') void categories.reload(); else void loadTags(); }}
          onClose={() => { if (!mutation.isPendingSync('bulk')) setBatchTarget(null); }}
          onSubmit={change => void submitBatch(change)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          busy={mutation.isPending('delete')}
          confirmLabel="删除"
          description={deleteTarget.kind === 'single'
            ? `确认删除“${deleteTarget.item.name}”？知识库会进入回收站，可随时恢复。`
            : `确认删除选中的 ${deleteTarget.ids.length} 个知识库？它们会进入回收站，可随时恢复。`}
          error={deleteError}
          onCancel={() => {
            setDeleteError('');
            setDeleteTarget(null);
          }}
          onConfirm={() => void confirmDelete()}
          title={deleteTarget.kind === 'single' ? '删除知识库' : '批量删除知识库'}
        />
      )}

      <KnowledgeBaseRecycleBinDrawer
        onChanged={() => {
          void reload();
          refreshRecycleCount();
        }}
        onClose={() => setRecycleOpen(false)}
        open={recycleOpen}
      />
    </AppShell>
  );
}
