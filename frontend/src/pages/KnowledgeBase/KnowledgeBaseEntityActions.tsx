import { Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  deleteKnowledgeBase,
  listKnowledgeBaseCategories,
  listKnowledgeBaseTags,
  updateKnowledgeBase,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/feedback/ToastProvider';
import { OverflowMenu } from '../../components/ui/OverflowMenu';
import type { KnowledgeBase, KnowledgeBaseCategory, KnowledgeBaseTag } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { KnowledgeBaseFormOverlay, type KnowledgeBaseFormState } from './KnowledgeBaseDrawers';

type KnowledgeBaseEntityActionsProps = {
  disabled?: boolean;
  knowledgeBase: KnowledgeBase;
  onDeleted: (knowledgeBaseId: string) => void;
  onUpdated: (knowledgeBase: KnowledgeBase) => void;
};

export function KnowledgeBaseEntityActions({
  disabled = false,
  knowledgeBase,
  onDeleted,
  onUpdated,
}: KnowledgeBaseEntityActionsProps) {
  const toast = useToast();
  const activeKnowledgeBaseIdRef = useRef(knowledgeBase.id);
  const mutationRef = useRef<symbol | null>(null);
  const metadataRequestRef = useRef(0);
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [tags, setTags] = useState<KnowledgeBaseTag[]>([]);
  const [form, setForm] = useState<KnowledgeBaseFormState | null>(null);
  const [formError, setFormError] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [working, setWorking] = useState<'update' | 'delete' | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  activeKnowledgeBaseIdRef.current = knowledgeBase.id;

  useEffect(() => {
    activeKnowledgeBaseIdRef.current = knowledgeBase.id;
    mutationRef.current = null;
    metadataRequestRef.current += 1;
    setCategories([]);
    setTags([]);
    setForm(null);
    setFormError('');
    setDeleteOpen(false);
    setDeleteError('');
    setWorking(null);
    setOptionsLoading(false);
    setOptionsError('');

    return () => {
      if (activeKnowledgeBaseIdRef.current === knowledgeBase.id) {
        activeKnowledgeBaseIdRef.current = '';
      }
      mutationRef.current = null;
      metadataRequestRef.current += 1;
    };
  }, [knowledgeBase.id]);

  async function loadOptions() {
    const requestedId = knowledgeBase.id;
    const request = ++metadataRequestRef.current;
    setOptionsLoading(true);
    setOptionsError('');
    try {
      const [categoryResponse, tagResponse] = await Promise.all([
        listKnowledgeBaseCategories(),
        listKnowledgeBaseTags(),
      ]);
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && metadataRequestRef.current === request
      ) {
        setCategories(categoryResponse.items);
        setTags(tagResponse.items);
      }
    } catch {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && metadataRequestRef.current === request
      ) {
        setOptionsError('分类和标签加载失败，请重试后再保存。');
      }
    } finally {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && metadataRequestRef.current === request
      ) {
        setOptionsLoading(false);
      }
    }
  }

  function openForm() {
    if (disabled || mutationRef.current) {
      return;
    }
    setFormError('');
    setForm({
      id: knowledgeBase.id,
      name: knowledgeBase.name,
      description: knowledgeBase.description,
      categoryId: knowledgeBase.categoryId ?? '',
      visibility: knowledgeBase.visibility ?? 'private',
      tagIds: knowledgeBase.tags?.map((tag) => tag.id) ?? [],
    });
    void loadOptions();
  }

  async function handleUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || mutationRef.current) {
      return;
    }

    const requestedId = knowledgeBase.id;
    const operation = Symbol('update-knowledge-base');
    mutationRef.current = operation;
    setWorking('update');
    setFormError('');

    try {
      const updated = await updateKnowledgeBase(requestedId, {
        name: form.name.trim(),
        description: form.description.trim(),
        categoryId: form.categoryId || null,
        visibility: form.visibility,
        retrievalConfig: knowledgeBase.retrievalConfig,
        tagIds: form.tagIds,
      });
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && mutationRef.current === operation
      ) {
        onUpdated(updated);
        setForm(null);
        toast.success('知识库更新成功');
      }
    } catch (error) {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && mutationRef.current === operation
      ) {
        setFormError(getErrorMessage(error, '知识库保存失败'));
      }
    } finally {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && mutationRef.current === operation
      ) {
        mutationRef.current = null;
        setWorking(null);
      }
    }
  }

  function openDelete() {
    if (disabled || mutationRef.current) {
      return;
    }
    setDeleteError('');
    setDeleteOpen(true);
  }

  async function handleDelete() {
    if (!deleteOpen || mutationRef.current) {
      return;
    }

    const requestedId = knowledgeBase.id;
    const operation = Symbol('delete-knowledge-base');
    mutationRef.current = operation;
    setWorking('delete');
    setDeleteError('');

    try {
      await deleteKnowledgeBase(requestedId);
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && mutationRef.current === operation
      ) {
        setDeleteOpen(false);
        toast.success('知识库已移入回收站');
        onDeleted(requestedId);
      }
    } catch (error) {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && mutationRef.current === operation
      ) {
        setDeleteError(getErrorMessage(error, '知识库删除失败'));
      }
    } finally {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && mutationRef.current === operation
      ) {
        mutationRef.current = null;
        setWorking(null);
      }
    }
  }

  return (
    <>
      <OverflowMenu
        disabled={disabled || working !== null}
        label={`${knowledgeBase.name}的更多操作`}
        items={[
          {
            label: '编辑知识库',
            icon: <Pencil aria-hidden="true" />,
            onSelect: openForm,
          },
          {
            label: '删除知识库',
            icon: <Trash2 aria-hidden="true" />,
            tone: 'danger',
            onSelect: openDelete,
          },
        ]}
      />

      {form && (
        <KnowledgeBaseFormOverlay
          busy={working === 'update'}
          categories={withCurrentCategory(flattenCategoryOptions(categories), form.categoryId)}
          error={formError}
          form={form}
          optionsError={optionsError}
          optionsLoading={optionsLoading}
          tags={mergeKnowledgeBaseTags(tags, knowledgeBase.tags ?? [])}
          onChange={(nextForm) => {
            setForm(nextForm);
            if (formError) {
              setFormError('');
            }
          }}
          onClose={() => {
            setForm(null);
            setFormError('');
          }}
          onRetryOptions={() => void loadOptions()}
          onSubmit={(event) => void handleUpdate(event)}
        />
      )}

      {deleteOpen && (
        <ConfirmDialog
          busy={working === 'delete'}
          confirmLabel="删除"
          description={`“${knowledgeBase.name}”将移入回收站，其中的文档和问答将暂时不可用。`}
          error={deleteError}
          onCancel={() => {
            if (!working) {
              setDeleteOpen(false);
              setDeleteError('');
            }
          }}
          onConfirm={() => void handleDelete()}
          title="删除知识库"
        />
      )}
    </>
  );
}

function flattenCategoryOptions(
  categories: KnowledgeBaseCategory[],
  level = 0,
): Array<{ id: string; label: string }> {
  return categories.flatMap((category) => [
    { id: category.id, label: `${'— '.repeat(level)}${category.name}` },
    ...flattenCategoryOptions(category.children ?? [], level + 1),
  ]);
}

function withCurrentCategory(
  categories: Array<{ id: string; label: string }>,
  currentCategoryId: string,
): Array<{ id: string; label: string }> {
  if (!currentCategoryId || categories.some((category) => category.id === currentCategoryId)) {
    return categories;
  }
  return [{ id: currentCategoryId, label: '当前分类' }, ...categories];
}

function mergeKnowledgeBaseTags(primary: KnowledgeBaseTag[], fallback: KnowledgeBaseTag[]): KnowledgeBaseTag[] {
  const merged = new Map(fallback.map((tag) => [tag.id, tag]));
  primary.forEach((tag) => merged.set(tag.id, tag));
  return [...merged.values()];
}
