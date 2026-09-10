import { useState } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input } from '../../components/ui/Field';

export function ChatSessionRenameDialog({ title, busy, error, onClose, onSubmit }: {
  title: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  const [draft, setDraft] = useState(title);
  return (
    <Dialog open title="重命名会话" onClose={() => { if (!busy) onClose(); }}>
      <form className="ui-form" onSubmit={(event) => {
        event.preventDefault();
        if (!busy && draft.trim()) onSubmit(draft.trim());
      }}>
        <Field label="会话名称" htmlFor="chat-session-name">
          <Input data-autofocus id="chat-session-name" disabled={busy} required value={draft}
            onChange={(event) => setDraft(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
        </Field>
        {error && <p className="ui-dialog__error" role="alert">{error}</p>}
        <div className="ui-dialog__actions">
          <Button disabled={busy} variant="secondary" onClick={onClose}>取消</Button>
          <Button disabled={!draft.trim()} loading={busy} type="submit">保存</Button>
        </div>
      </form>
    </Dialog>
  );
}
