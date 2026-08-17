import { Plus, Settings2 } from 'lucide-react';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import type { KnowledgeBaseCategory } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { CategoryDialog } from './CategoryDialog';
import type { CategoryDialogValue } from './CategoryDialog';
import { CategoryTree } from './CategoryTree';
import {
  descendantCategoryIds,
  flattenCategories,
  nextCategorySortOrder,
} from './categoryTreeUtils';
import type { useCategories } from './useCategories';

type CategoryPanelProps = {
  controller: ReturnType<typeof useCategories>;
  selectedId: string;
  totalCount: number | null;
  expandedIds: string[];
  /** Toggles the filter: selecting the active category clears it. */
  onSelect: (categoryId: string) => void;
  onClear: () => void;
  onToggleExpanded: (categoryId: string) => void;
};

/**
 * The category tree now lives inside the knowledge-base page rather than the app
 * rail, so the rail stays identical on every route. Editing is an inline mode on
 * this panel instead of a drawer that then opens a dialog.
 */
export function CategoryPanel({
  controller,
  selectedId,
  totalCount,
  expandedIds,
  onSelect,
  onClear,
  onToggleExpanded,
}: CategoryPanelProps) {
  const toast = useToast();
  const { categories, loading, error, pendingIds, reload, save, remove, move } = controller;
  const [managing, setManaging] = useState(false);
  const [form, setForm] = useState<CategoryDialogValue | null>(null);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseCategory | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const flat = flattenCategories(categories);
  const parentOptions = form?.id
    ? flat.filter((option) => {
      const blocked = new Set([form.id as string, ...descendantCategoryIds(categories, form.id as string)]);
      return !blocked.has(option.id);
    })
    : flat;

  function openCreate(parentId = '') {
    setFormError('');
    setForm({ name: '', parentId, sortOrder: nextCategorySortOrder(categories, parentId || null) });
  }

  function openEdit(category: KnowledgeBaseCategory) {
    setFormError('');
    setForm({
      id: category.id,
      name: category.name,
      parentId: category.parentId ?? '',
      sortOrder: category.sortOrder,
    });
  }

  async function submitForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    setSubmitting(true);
    setFormError('');
    try {
      await save(
        { name: form.name.trim(), parentId: form.parentId || null, sortOrder: form.sortOrder },
        form.id,
      );
      toast.success(form.id ? '分类更新成功' : '分类创建成功');
      setForm(null);
    } catch (caught) {
      setFormError(getErrorMessage(caught, '分类保存失败'));
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await remove(deleteTarget.id);
      if (selectedId === deleteTarget.id) onClear();
      toast.success('分类删除成功');
      setDeleteTarget(null);
    } catch (caught) {
      setDeleteError(getErrorMessage(caught, '分类删除失败'));
    } finally {
      setDeleting(false);
    }
  }

  async function handleMove(categoryId: string, direction: 'up' | 'down') {
    try {
      await move(categoryId, direction);
    } catch (caught) {
      toast.error(getErrorMessage(caught, '分类排序保存失败'));
    }
  }

  return (
    <aside aria-label="知识库分类" className="cat-panel">
      <div className="cat-panel__head">
        <strong>分类</strong>
        <IconButton
          aria-pressed={managing}
          className={managing ? 'is-on' : undefined}
          label={managing ? '退出分类管理' : '管理分类'}
          onClick={() => setManaging((value) => !value)}
        >
          <Settings2 aria-hidden="true" />
        </IconButton>
      </div>

      <button
        aria-current={selectedId === '' ? 'true' : undefined}
        className={selectedId === '' ? 'cat-panel__all is-selected' : 'cat-panel__all'}
        onClick={onClear}
        type="button"
      >
        <span>全部</span>
        {totalCount !== null && <span className="cat-panel__count ui-num">{totalCount}</span>}
      </button>

      {loading && categories.length === 0 ? (
        <LoadingSkeleton compact columns={1} rows={4} />
      ) : error ? (
        <div className="ui-inline-error" role="alert">
          <span>{error}</span>
          <Button variant="link" onClick={() => void reload()}>重试</Button>
        </div>
      ) : (
        <CategoryTree
          categories={categories}
          expandedIds={expandedIds}
          onCreateCategory={managing ? openCreate : undefined}
          onDeleteCategory={managing ? (category) => {
            setDeleteError('');
            setDeleteTarget(category);
          } : undefined}
          onEditCategory={managing ? openEdit : undefined}
          onMoveCategory={managing ? (id, direction) => void handleMove(id, direction) : undefined}
          onSelectCategory={onSelect}
          onToggleExpanded={onToggleExpanded}
          pendingIds={pendingIds}
          selectedId={selectedId}
        />
      )}

      {managing && (
        <Button
          className="cat-panel__add"
          leadingIcon={<Plus aria-hidden="true" />}
          variant="secondary"
          onClick={() => openCreate()}
        >
          新建分类
        </Button>
      )}

      <CategoryDialog
        error={formError}
        onChange={setForm}
        onClose={() => {
          setForm(null);
          setFormError('');
        }}
        onParentChange={(parentId) => {
          if (!form) return;
          setForm({
            ...form,
            parentId,
            sortOrder: nextCategorySortOrder(categories, parentId || null),
          });
        }}
        onSubmit={(event) => void submitForm(event)}
        parentOptions={parentOptions}
        submitting={submitting}
        value={form}
      />

      {deleteTarget && (
        <ConfirmDialog
          busy={deleting}
          confirmLabel="删除"
          description={`确认删除“${deleteTarget.name}”？包含子分类或知识库的分类无法删除。`}
          error={deleteError}
          onCancel={() => {
            setDeleteError('');
            setDeleteTarget(null);
          }}
          onConfirm={() => void confirmDelete()}
          title="删除分类"
        />
      )}
    </aside>
  );
}
