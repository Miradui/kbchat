import { useCallback, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Checkbox, Field, Input, Select, Textarea } from '../../components/ui/Field';
import type { KnowledgeBaseTag } from '../../types/api';
import type { CategoryOption } from './categoryTreeUtils';

export type KnowledgeBaseFormState = {
  id?: string;
  name: string;
  description: string;
  categoryId: string;
  visibility: 'private' | 'public';
  tagIds: string[];
};

type KnowledgeBaseFormDialogProps = {
  busy: boolean;
  categories: CategoryOption[];
  error: string;
  form: KnowledgeBaseFormState;
  optionsError?: string;
  optionsLoading?: boolean;
  tags: KnowledgeBaseTag[];
  onChange: (form: KnowledgeBaseFormState) => void;
  onClose: () => void;
  onRetryOptions?: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

/**
 * Create and edit share one dialog. The old build used a centred dialog for
 * create and a side drawer for edit, which meant the same six fields lived in
 * two different layouts.
 */
export function KnowledgeBaseFormDialog({
  busy,
  categories,
  error,
  form,
  optionsError = '',
  optionsLoading = false,
  tags,
  onChange,
  onClose,
  onRetryOptions,
  onSubmit,
}: KnowledgeBaseFormDialogProps) {
  const nameId = useId();
  const descriptionId = useId();
  const categoryId = useId();
  const visibilityId = useId();
  const initialRef = useRef(form);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const editing = Boolean(form.id);
  const dirty = !formsEqual(form, initialRef.current);
  useUnsavedChangesWarning(dirty);

  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [busy, dirty, onClose]);

  function toggleTag(tagId: string) {
    const tagIds = form.tagIds.includes(tagId)
      ? form.tagIds.filter((id) => id !== tagId)
      : [...form.tagIds, tagId];
    onChange({ ...form, tagIds });
  }

  const optionsBlocked = optionsLoading || Boolean(optionsError);

  return (
    <>
      <Dialog
        className="ui-dialog--wide"
        description={editing ? '更新基础信息、分类、标签和访问权限。' : '仅名称必填，创建后可直接导入文档。'}
        onClose={requestClose}
        open
        title={editing ? '编辑知识库' : '新建知识库'}
      >
        <form className="ui-dialog__form" onSubmit={onSubmit}>
          <Field htmlFor={nameId} label="名称">
            <Input
              data-autofocus
              disabled={busy}
              id={nameId}
              onChange={(event) => onChange({ ...form, name: event.target.value })}
              required
              value={form.name}
            />
          </Field>

          <Field htmlFor={descriptionId} label="描述">
            <Textarea
              disabled={busy}
              id={descriptionId}
              onChange={(event) => onChange({ ...form, description: event.target.value })}
              rows={3}
              value={form.description}
            />
          </Field>

          <div className="kb-form__row">
            <Field htmlFor={categoryId} label="分类">
              <Select
                disabled={busy || optionsBlocked}
                id={categoryId}
                onChange={(event) => onChange({ ...form, categoryId: event.target.value })}
                value={form.categoryId}
              >
                <option value="">未分类</option>
                {categories.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </Select>
            </Field>

            <Field htmlFor={visibilityId} label="访问权限">
              <Select
                disabled={busy}
                id={visibilityId}
                onChange={(event) => onChange({ ...form, visibility: event.target.value as 'private' | 'public' })}
                value={form.visibility}
              >
                <option value="private">私有</option>
                <option value="public">公开</option>
              </Select>
            </Field>
          </div>

          <fieldset className="kb-form__tags">
            <legend className="ui-field__label">标签</legend>
            {tags.length === 0 ? (
              <p className="ui-field__hint">暂无可用标签</p>
            ) : (
              <div className="kb-form__tag-options">
                {tags.map((tag) => (
                  <label className="kb-form__tag-option" key={tag.id}>
                    <Checkbox
                      checked={form.tagIds.includes(tag.id)}
                      disabled={busy || optionsBlocked}
                      onChange={() => toggleTag(tag.id)}
                    />
                    <span>{tag.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {optionsLoading && <p className="ui-field__hint" role="status">正在加载分类和标签…</p>}
          {optionsError && (
            <div className="ui-inline-error" role="alert">
              <span>{optionsError}</span>
              {onRetryOptions && <Button variant="link" onClick={onRetryOptions}>重试加载</Button>}
            </div>
          )}
          {error && <p className="ui-dialog__error" role="alert">{error}</p>}

          <div className="ui-dialog__actions">
            <Button variant="secondary" disabled={busy} onClick={requestClose}>取消</Button>
            <Button disabled={optionsBlocked} loading={busy} loadingLabel="保存中" type="submit">
              {editing ? '保存修改' : '创建并导入文档'}
            </Button>
          </div>
        </form>
      </Dialog>

      {confirmDiscard && (
        <ConfirmDialog
          cancelLabel="继续编辑"
          confirmLabel="放弃更改"
          description="当前修改尚未保存，关闭后将丢失。"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
          title="放弃未保存的更改"
        />
      )}
    </>
  );
}

function formsEqual(left: KnowledgeBaseFormState, right: KnowledgeBaseFormState): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.description === right.description
    && left.categoryId === right.categoryId
    && left.visibility === right.visibility
    && [...left.tagIds].sort().join(',') === [...right.tagIds].sort().join(',');
}
