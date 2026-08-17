import { useId } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Select } from '../../components/ui/Field';
import type { CategoryOption } from './categoryTreeUtils';

type KnowledgeBaseMoveDialogProps = {
  busy: boolean;
  categories: CategoryOption[];
  error: string;
  knowledgeBaseName: string;
  targetCategoryId: string;
  onChange: (categoryId: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function KnowledgeBaseMoveDialog({
  busy,
  categories,
  error,
  knowledgeBaseName,
  targetCategoryId,
  onChange,
  onClose,
  onSubmit,
}: KnowledgeBaseMoveDialogProps) {
  const selectId = useId();

  return (
    <Dialog
      description={`为“${knowledgeBaseName}”选择目标分类。`}
      onClose={onClose}
      open
      title="移动到分类"
    >
      <form className="ui-dialog__form" onSubmit={onSubmit}>
        <Field htmlFor={selectId} label="目标分类">
          <Select
            data-autofocus
            disabled={busy}
            id={selectId}
            onChange={(event) => onChange(event.target.value)}
            value={targetCategoryId}
          >
            <option value="">未分类</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.label}</option>
            ))}
          </Select>
        </Field>
        {error && <p className="ui-dialog__error" role="alert">{error}</p>}
        <div className="ui-dialog__actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button loading={busy} loadingLabel="移动中" type="submit">移动</Button>
        </div>
      </form>
    </Dialog>
  );
}
