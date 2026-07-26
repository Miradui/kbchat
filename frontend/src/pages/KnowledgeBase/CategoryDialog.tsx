import { useId } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';

export type CategoryDialogValue = {
  id?: string;
  name: string;
  parentId: string;
  sortOrder: number;
};

type CategoryParentOption = {
  id: string;
  label: string;
};

type CategoryDialogProps = {
  value: CategoryDialogValue | null;
  parentOptions: CategoryParentOption[];
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
  const errorId = useId();

  return (
    <Dialog
      open={Boolean(value)}
      title={value?.id ? '编辑分类' : '新建分类'}
      description="分类用于组织和筛选知识库。"
      onClose={onClose}
    >
      {value && (
        <form className="category-dialog-form" onSubmit={onSubmit}>
          <label htmlFor="category-name">分类名称</label>
          <input
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error)}
            data-autofocus
            id="category-name"
            required
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
          />

          <label htmlFor="category-parent">父分类</label>
          <select
            id="category-parent"
            value={value.parentId}
            onChange={(event) => onParentChange(event.target.value)}
          >
            <option value="">根分类</option>
            {parentOptions.map((category) => (
              <option key={category.id} value={category.id}>{category.label}</option>
            ))}
          </select>

          {error && <p className="field-error" id={errorId} role="alert">{error}</p>}

          <div className="ui-dialog__actions">
            <Button variant="secondary" disabled={submitting} onClick={onClose}>取消</Button>
            <Button loading={submitting} loadingLabel="保存中" type="submit">保存分类</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
