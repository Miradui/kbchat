import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { getErrorMessage } from '../../utils/errors';

export type TagDialogProps = {
  open: boolean;
  initialName: string;
  title: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
};

export function TagDialog({ open, initialName, title, onClose, onSubmit }: TagDialogProps) {
  const submittingRef = useRef(false);
  const [name, setName] = useState(initialName);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = open && name !== initialName;

  useEffect(() => {
    if (open) {
      submittingRef.current = false;
      setName(initialName);
      setError('');
      setSubmitting(false);
      setConfirmDiscard(false);
    }
  }, [initialName, open]);

  useUnsavedChangesWarning(dirty);

  function close() {
    if (submittingRef.current) {
      return;
    }
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
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
    <>
      <Dialog open={open} title={title} description="标签可在知识库创建和编辑时绑定。" onClose={close}>
        <form className="ui-dialog__form" onSubmit={handleSubmit}>
          <Field error={error} htmlFor="tag-name" label="标签名称">
            <Input
              data-autofocus
              id="tag-name"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </Field>
          <div className="ui-dialog__actions">
            <Button variant="secondary" disabled={submitting} onClick={close}>取消</Button>
            <Button loading={submitting} loadingLabel="保存中" type="submit">保存标签</Button>
          </div>
        </form>
      </Dialog>
      {confirmDiscard && (
        <ConfirmDialog
          cancelLabel="继续编辑"
          confirmLabel="放弃更改"
          description="当前标签修改尚未保存，关闭后将丢失。"
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
