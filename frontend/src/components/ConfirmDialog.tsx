import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

type ConfirmDialogProps = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  busy = false,
  error,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const handleCancel = () => {
    if (!busy) onCancel();
  };
  const handleConfirm = () => {
    if (!busy) onConfirm();
  };

  return (
    <Dialog open title={title} description={description} onClose={handleCancel}>
      {error && <p className="ui-dialog__error" role="alert">{error}</p>}
      <div className="ui-dialog__actions">
        <Button variant="secondary" disabled={busy} onClick={handleCancel}>{cancelLabel}</Button>
        <Button variant="danger" loading={busy} loadingLabel="处理中" onClick={handleConfirm}>{confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
