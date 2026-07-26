import type { FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';

type KnowledgeBaseMoveDialogProps = {
  busy: boolean;
  categories: { id: string; label: string }[];
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
  return (
    <Dialog
      open
      title="移动知识库"
      description={`为“${knowledgeBaseName}”选择目标分类。`}
      onClose={onClose}
    >
      <form className="kb-move-dialog-form" onSubmit={onSubmit}>
        <label>
          目标分类
          <select
            data-autofocus
            disabled={busy}
            value={targetCategoryId}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">未分类</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.label}</option>
            ))}
          </select>
        </label>
        {error && <p className="ui-dialog__error" role="alert">{error}</p>}
        <div className="ui-dialog__actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button loading={busy} loadingLabel="移动中" type="submit">移动</Button>
        </div>
      </form>
    </Dialog>
  );
}
