import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { createChatBranch } from '../../api/resources';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input } from '../../components/ui/Field';
import type { ChatMessage, ChatSession } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

export function ChatBranchDialog({ message, onClose, onCreated, onInaccessible }: {
  message: ChatMessage; onClose: () => void; onCreated: (session: ChatSession) => void;
  onInaccessible: (error: unknown, sessionId: string) => boolean;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState(''); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChatSession | null>(null); const [error, setError] = useState('');
  const pending = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const session = await createChatBranch(message.sessionId, { messageId: message.id, clientRequestId: requestId, title: title.trim() });
      if (mounted.current) { setResult(session); onCreated(session); }
    } catch (caught) {
      if (mounted.current && !onInaccessible(caught, message.sessionId)) setError(getErrorMessage(caught, '分支创建未确认，可重试；同一请求不会重复创建。'));
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <Dialog open title="从此回答创建分支" description="复制到当前回答版本为止的历史和引用，在新会话中继续探索。" onClose={() => { if (!pending.current) onClose(); }}>
    {result ? <>
      <p role="status">已创建「{result.title}」。</p>
      <div className="ui-dialog__actions"><Button variant="secondary" onClick={onClose}>留在当前会话</Button><Link className="ui-button ui-button--primary" to={`/chat/${result.id}`} onClick={onClose}>打开新分支</Link></div>
    </> : <form className="ui-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Field label="新会话标题（可选）"><Input aria-label="新会话标题" maxLength={100} disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="默认使用原标题并标记分支" /></Field>
      <p className="chat-branch-excerpt">{message.content.slice(0, 200)}{message.content.length > 200 ? '…' : ''}</p>
      {error && <p role="alert" className="ui-inline-error">{error}</p>}
      <div className="ui-dialog__actions"><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" loading={busy}>创建分支</Button></div>
    </form>}
  </Dialog>;
}
