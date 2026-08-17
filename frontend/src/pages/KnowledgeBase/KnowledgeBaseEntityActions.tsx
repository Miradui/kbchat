import { Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

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
import { KnowledgeBaseFormDialog } from './KnowledgeBaseFormDialog';
import type { KnowledgeBaseFormState } from './KnowledgeBaseFormDialog';
import { flattenCategories, withCurrentCategory } from './categoryTreeUtils';

type KnowledgeBaseEntityActionsProps = {
  disabled?: boolean;
  knowledgeBase: KnowledgeBase;
  onDeleted: (knowledgeBaseId: string) => void;
  onUpdated: (knowledgeBase: KnowledgeBase) => void;
};

/** Edit and delete for a single knowledge base, shared by detail and documents. */
export function KnowledgeBaseEntityActions({
  disabled = false,
  knowledgeBase,
  onDeleted,
  onUpdated,
}: KnowledgeBaseEntityActionsProps) {
  const toast = useToast();
  const activeIdRef = useRef(knowledgeBase.id);
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
  activeIdRef.current = knowledgeBase.id;

  useEffect(() => {
    metadataRequestRef.current += 1;
    setForm(null);
    setFormError('');
    setDeleteOpen(false);
    setDeleteError('');
    setWorking(null);
    setOptionsError('');
  }, [knowledgeBase.id]);

  const loadOptions = useCallback(async () => {
    const requestedId = knowledgeBase.id;
    const request = ++metadataRequestRef.current;
    setOptionsLoading(true);
    setOptionsError('');
    try {
      const [categoryResponse, tagResponse] = await Promise.all([
        listKnowledgeBaseCategories(),
        listKnowledgeBaseTags(),
      ]);
      if (activeIdRef.current === requestedId && metadataRequestRef.current === request) {
        setCategories(categoryResponse.items);
        setTags(tagResponse.items);
      }
    } catch {
      if (activeIdRef.current === requestedId && metadataRequestRef.current === request) {
        setOptionsError('分类和标签加载失败，请重试后再保存。');
      }
    } finally {
      if (activeIdRef.current === requestedId && metadataRequestRef.current === request) {
        setOptionsLoading(false);
      }
    }
  }, [knowledgeBase.id]);

  function openForm() {
    if (disabled || working) return;
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
    if (!form || working) return;

    const requestedId = knowledgeBase.id;
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
      if (activeIdRef.current === requestedId) {
        onUpdated(updated);
        setForm(null);
        toast.success('知识库更新成功');
      }
    } catch (caught) {
      if (activeIdRef.current === requestedId) {
        setFormError(getErrorMessage(caught, '知识库保存失败'));
      }
    } finally {
      if (activeIdRef.current === requestedId) setWorking(null);
    }
  }

  async function handleDelete() {
    if (working) return;
    const requestedId = knowledgeBase.id;
    setWorking('delete');
    setDeleteError('');
    try {
      await deleteKnowledgeBase(requestedId);
      if (activeIdRef.current === requestedId) {
        setDeleteOpen(false);
        toast.success('知识库已移入回收站');
        onDeleted(requestedId);
      }
    } catch (caught) {
      if (activeIdRef.current === requestedId) {
        setDeleteError(getErrorMessage(caught, '知识库删除失败'));
      }
    } finally {
      if (activeIdRef.current === requestedId) setWorking(null);
    }
  }

  return (
    <>
      <OverflowMenu
        disabled={disabled || working !== null}
        label={`${knowledgeBase.name} 的更多操作`}
        items={[
          { label: '编辑知识库', icon: <Pencil aria-hidden="true" />, onSelect: openForm },
          {
            label: '删除知识库',
            icon: <Trash2 aria-hidden="true" />,
            tone: 'danger',
            onSelect: () => {
              if (disabled || working) return;
              setDeleteError('');
              setDeleteOpen(true);
            },
          },
        ]}
      />

      {form && (
        <KnowledgeBaseFormDialog
          busy={working === 'update'}
          categories={withCurrentCategory(flattenCategories(categories), form.categoryId)}
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
          onRetryOptions={() => void loadOptions()}
          onSubmit={(event) => void handleUpdate(event)}
          optionsError={optionsError}
          optionsLoading={optionsLoading}
          tags={mergeTags(tags, knowledgeBase.tags ?? [])}
        />
      )}

      {deleteOpen && (
        <ConfirmDialog
          busy={working === 'delete'}
          confirmLabel="删除"
          description={`“${knowledgeBase.name}”将移入回收站，其中的文档和问答会暂时不可用。`}
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

/** Keeps tags already bound to this knowledge base selectable if the list request failed. */
function mergeTags(primary: KnowledgeBaseTag[], fallback: KnowledgeBaseTag[]): KnowledgeBaseTag[] {
  const merged = new Map(fallback.map((tag) => [tag.id, tag]));
  primary.forEach((tag) => merged.set(tag.id, tag));
  return [...merged.values()];
}
