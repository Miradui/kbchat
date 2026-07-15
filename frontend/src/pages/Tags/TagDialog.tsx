import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { getErrorMessage } from '../../utils/errors';

export type TagDialogProps = {
  open: boolean;
  initialName: string;
  title: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
};

export function TagDialog({ open, initialName, title, onClose, onSubmit }: TagDialogProps) {
  const errorId = useId();
  const submittingRef = useRef(false);
  const [name, setName] = useState(initialName);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      submittingRef.current = false;
      setName(initialName);
      setError('');
      setSubmitting(false);
    }
  }, [initialName, open]);

  function close() {
    if (!submittingRef.current) {
      onClose();
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) {
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请输入标签名称');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      await onSubmit(trimmedName);
      submittingRef.current = false;
      onClose();
    } catch (caught) {
      setError(getErrorMessage(caught, '标签保存失败'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} title={title} description="标签可在知识库创建和编辑时绑定。" onClose={close}>
      <form className="tag-dialog-form" onSubmit={handleSubmit}>
        <label htmlFor="tag-name">标签名称</label>
        <input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={Boolean(error)}
          id="tag-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {error && <p className="field-error" id={errorId} role="alert">{error}</p>}
        <div className="ui-dialog__actions">
          <Button variant="secondary" disabled={submitting} onClick={close}>取消</Button>
          <Button loading={submitting} loadingLabel="保存中" type="submit">保存标签</Button>
        </div>
      </form>
    </Dialog>
  );
}
