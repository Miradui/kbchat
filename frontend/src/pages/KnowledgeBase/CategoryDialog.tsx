import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input, Select } from '../../components/ui/Field';
import type { CategoryOption } from './categoryTreeUtils';

export type CategoryDialogValue = {
  id?: string;
  name: string;
  parentId: string;
  sortOrder: number;
};

type CategoryDialogProps = {
  value: CategoryDialogValue | null;
  parentOptions: CategoryOption[];
  error: string;
  submitting: boolean;
  onChange: (value: CategoryDialogValue) => void;
  onClose: () => void;
  onParentChange: (parentId: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function CategoryDialog({
  value,
  parentOptions,
  error,
  submitting,
  onChange,
  onClose,
  onParentChange,
  onSubmit,
}: CategoryDialogProps) {
  const nameId = useId();
  const parentId = useId();
  const initialRef = useRef<CategoryDialogValue | null>(null);
  const wasOpenRef = useRef(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = Boolean(value && initialRef.current && !equal(value, initialRef.current));

  useEffect(() => {
    if (value && !wasOpenRef.current) {
      initialRef.current = { ...value };
      wasOpenRef.current = true;
      setConfirmDiscard(false);
      return;
    }
    if (!value) {
      initialRef.current = null;
      wasOpenRef.current = false;
      setConfirmDiscard(false);
    }
  }, [value]);

  useUnsavedChangesWarning(dirty);

  function requestClose() {
    if (submitting) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  return (
    <>
      <Dialog
        description="分类用于组织和筛选知识库。"
        onClose={requestClose}
        open={Boolean(value)}
        title={value?.id ? '编辑分类' : '新建分类'}
      >
        {value && (
          <form className="ui-dialog__form" onSubmit={onSubmit}>
            <Field error={error} htmlFor={nameId} label="分类名称">
              <Input
                aria-invalid={Boolean(error)}
                data-autofocus
                id={nameId}
                onChange={(event) => onChange({ ...value, name: event.target.value })}
                required
                value={value.name}
              />
            </Field>

            <Field htmlFor={parentId} label="父分类">
              <Select
                id={parentId}
                onChange={(event) => onParentChange(event.target.value)}
                value={value.parentId}
              >
                <option value="">根分类</option>
                {parentOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </Select>
            </Field>

            <div className="ui-dialog__actions">
              <Button variant="secondary" disabled={submitting} onClick={requestClose}>取消</Button>
              <Button loading={submitting} loadingLabel="保存中" type="submit">保存分类</Button>
            </div>
          </form>
        )}
      </Dialog>

      {confirmDiscard && (
        <ConfirmDialog
          cancelLabel="继续编辑"
          confirmLabel="放弃更改"
          description="当前分类修改尚未保存，关闭后将丢失。"
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

function equal(left: CategoryDialogValue, right: CategoryDialogValue): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.parentId === right.parentId
    && left.sortOrder === right.sortOrder;
}
