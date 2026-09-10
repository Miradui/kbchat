import { useRef, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Select } from '../../components/ui/Field';
import type { ChatFeedbackDetails, ChatFeedbackReason } from '../../types/api';
import { chatFeedbackReasons } from '../../utils/chatFeedback';

export function ChatFeedbackDialog({ initial, onClose, onSubmit }: {
  initial?: ChatFeedbackDetails | null;
  onClose: () => void;
  onSubmit: (details: ChatFeedbackDetails) => Promise<boolean>;
}) {
  const [reason, setReason] = useState<ChatFeedbackReason>(initial?.reason || 'inaccurate');
  const [comment, setComment] = useState(initial?.comment || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const pending = useRef(false);
  const dirty = reason !== (initial?.reason || 'inaccurate') || comment !== (initial?.comment || '');
  useUnsavedChangesWarning(dirty);
  function close() { if (!pending.current) { if (dirty) setDiscard(true); else onClose(); } }
  async function submit() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { if (await onSubmit({ reason, comment: comment.trim() })) onClose(); else setError('反馈未保存，请重试。'); }
    catch { setError('反馈未保存，请重试。'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <>
    <Dialog open onClose={close} title="这条回答哪里需要改进？" description="记录原因，便于定位问题并加入后续评测。">
      <form className="ui-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="差评原因"><Select aria-label="差评原因" disabled={busy} value={reason} onChange={(event) => setReason(event.target.value as ChatFeedbackReason)}>
          {Object.entries(chatFeedbackReasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select></Field>
        <Field label="补充说明（可选）" hint="最多 1000 字，可说明哪里不准确或缺少哪些内容。">
          <textarea aria-label="反馈补充说明" className="ui-input" disabled={busy} maxLength={1000} rows={4} value={comment} onChange={(event) => setComment(event.target.value)} />
        </Field>
        {error && <p className="ui-inline-error" role="alert">{error}</p>}
        <div className="ui-dialog__actions"><Button disabled={busy} onClick={close} variant="secondary">取消</Button><Button loading={busy} type="submit" variant="primary">保存反馈</Button></div>
      </form>
    </Dialog>
    {discard && <ConfirmDialog title="放弃反馈修改？" description="已填写的原因和说明将不会保存。" confirmLabel="放弃修改" onCancel={() => setDiscard(false)} onConfirm={onClose} />}
  </>;
}
