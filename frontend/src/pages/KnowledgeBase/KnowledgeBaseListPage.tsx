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
import { Select } from '../../components/ui/Field';
import { useEntityMutation } from '../../hooks/useEntityMutation';
import { AppShell } from '../../layouts/AppShell';
import type {
  KnowledgeBase,
  KnowledgeBaseBatchTagMode,
  KnowledgeBaseTag,
  RetrievalConfig,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { CategoryPanel } from './CategoryPanel';
import { KnowledgeBaseCards, KnowledgeBaseTable } from './KnowledgeBaseList';
import type { RowHandlers } from './KnowledgeBaseList';
import { KnowledgeBaseFormDialog } from './KnowledgeBaseFormDialog';
import type { KnowledgeBaseFormState } from './KnowledgeBaseFormDialog';
import { KnowledgeBaseMoveDialog } from './KnowledgeBaseMoveDialog';
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
  const [recycleCount, setRecycleCount] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkCategoryId, setBulkCategoryId] = useState('');
  const [bulkTagId, setBulkTagId] = useState('');
  const [bulkTagMode, setBulkTagMode] = useState<KnowledgeBaseBatchTagMode>('add');
  const [form, setForm] = useState<KnowledgeBaseFormState | null>(null);
  const [formError, setFormError] = useState('');
  const [moveTarget, setMoveTarget] = useState<KnowledgeBase | null>(null);
  const [moveCategoryId, setMoveCategoryId] = useState('');
  const [moveError, setMoveError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [recycleOpen, setRecycleOpen] = useState(false);
  const openedCreateRef = useRef(false);

  const { items, total, loading, error, filters, activeFilterCount, viewMode, reload, setFilter } = list;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const categoryOptions = useMemo(() => flattenCategories(categories.categories), [categories.categories]);

  const refreshRecycleCount = useCallback(() => {
    void listKnowledgeBaseRecycleBin(1, 1)
      .then((response) => setRecycleCount(response.total))
      .catch(() => setRecycleCount(null));
  }, []);

  useEffect(() => {
    void listKnowledgeBaseTags()
      .then((response) => setTags(response.items))
      .catch(() => setTags([]));
    refreshRecycleCount();
  }, [refreshRecycleCount]);

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

  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const busy = mutation.anyPending;

  const rowHandlers: RowHandlers = {
    isPending: mutation.isPending,
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
            onCreate={openCreate}
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

          {selectedIds.length > 0 && (
            <div className="ui-bulkbar">
              <span className="ui-bulkbar__count">已选择 {selectedIds.length} 项</span>
              <Button
                disabled={mutation.isPending('bulk')}
                variant="secondary"
                onClick={() => void withRefresh(
                  'bulk',
                  async () => { await batchFavoriteKnowledgeBases(selectedIds, true); },
                  '已批量收藏',
                  '批量收藏失败',
                )}
              >
                收藏
              </Button>
              <Button
                disabled={mutation.isPending('bulk')}
                variant="secondary"
                onClick={() => void withRefresh(
                  'bulk',
                  async () => { await batchFavoriteKnowledgeBases(selectedIds, false); },
                  '已取消收藏',
                  '批量取消收藏失败',
                )}
              >
                取消收藏
              </Button>
              <Select
                aria-label="批量移动到分类"
                onChange={(event) => setBulkCategoryId(event.target.value)}
                value={bulkCategoryId}
              >
                <option value="">未分类</option>
                {categoryOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </Select>
              <Button
                disabled={mutation.isPending('bulk')}
                variant="secondary"
                onClick={() => void withRefresh(
                  'bulk',
                  async () => {
                    await batchMoveKnowledgeBases(selectedIds, bulkCategoryId || null);
                    setSelectedIds([]);
                  },
                  '知识库已批量移动',
                  '批量移动失败',
                )}
              >
                移动
              </Button>
              <Select
                aria-label="批量标签"
                onChange={(event) => setBulkTagId(event.target.value)}
                value={bulkTagId}
              >
                <option value="">选择标签</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>{tag.name}</option>
                ))}
              </Select>
              <Select
                aria-label="批量标签方式"
                onChange={(event) => setBulkTagMode(event.target.value as KnowledgeBaseBatchTagMode)}
                value={bulkTagMode}
              >
                <option value="add">添加</option>
                <option value="remove">移除</option>
                <option value="replace">替换</option>
              </Select>
              <Button
                disabled={mutation.isPending('bulk') || !bulkTagId}
                variant="secondary"
                onClick={() => void withRefresh(
                  'bulk',
                  async () => {
                    await batchTagKnowledgeBases(selectedIds, [bulkTagId], bulkTagMode);
                    setSelectedIds([]);
                  },
                  bulkTagFeedback[bulkTagMode].success,
                  bulkTagFeedback[bulkTagMode].failure,
                )}
              >
                应用标签
              </Button>
              <span className="ui-toolbar__spacer" />
              <Button
                variant="danger"
                onClick={() => {
                  setDeleteError('');
                  setDeleteTarget({ kind: 'batch', ids: selectedIds });
                }}
              >
                删除
              </Button>
            </div>
          )}

          <div className={loading && items.length > 0 ? 'kb-results is-refreshing' : 'kb-results'}>
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
