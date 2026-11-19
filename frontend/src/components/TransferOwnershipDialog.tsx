import { useEffect, useRef, useState } from 'react';
import { searchUsers } from '../api/resources';
import type { TransferOwnershipInput, UserSummary } from '../types/api';
import { getErrorMessage } from '../utils/errors';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Field, Input, Select } from './ui/Field';

// Mounted only while open, so each transfer starts with a fresh selection.
export function TransferOwnershipDialog({ ownerId, description, onTransfer, onClose, onDone }: {
  ownerId: string; description: string;
  onTransfer: (input: TransferOwnershipInput) => Promise<unknown>;
  onClose: () => void; onDone: () => void;
}) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [newOwnerId, setNewOwnerId] = useState('');
  const [keep, setKeep] = useState(true);
  const [searching, setSearching] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    setSearching(true);
    setUsers([]);
    setNewOwnerId('');
    const timer = window.setTimeout(() => {
      void searchUsers(query).then((result) => {
        if (active) { setUsers(result.items.filter((item) => item.id !== ownerId)); setError(''); }
      }).catch((caught) => { if (active) setError(getErrorMessage(caught, '无法搜索用户')); })
        .finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, ownerId]);
  async function submit() {
    if (!newOwnerId || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError('');
    try { await onTransfer({ newOwnerId, keepPreviousOwnerAsManager: keep }); onDone(); }
    catch (caught) { setError(getErrorMessage(caught, '转移失败')); }
    finally { submitting.current = false; setBusy(false); }
  }
  return (
    <Dialog open title="转移所有权" description={description} onClose={() => { if (!busy) onClose(); }}>
      <form className="ui-dialog__form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="搜索新所有者" htmlFor="transfer-query"><Input id="transfer-query" disabled={busy} value={query} onChange={(event) => setQuery(event.target.value)} /></Field>
        <Field label="新所有者" htmlFor="transfer-owner">
          <Select id="transfer-owner" disabled={busy || searching} value={newOwnerId} onChange={(event) => setNewOwnerId(event.target.value)}>
            <option value="">{searching ? '搜索中…' : users.length ? '请选择用户' : '没有匹配的启用用户'}</option>
            {users.map((item) => <option key={item.id} value={item.id}>{item.displayName}（{item.username}）</option>)}
          </Select>
        </Field>
        <label><input type="checkbox" checked={keep} disabled={busy} onChange={(event) => setKeep(event.target.checked)} /> 保留原所有者为知识库管理员</label>
        <p className="ui-muted">转移后原所有者不再拥有删除、恢复和转移知识库的权限。未保留成员身份时，也将失去该知识库及其会话的访问权。</p>
        {error && <p role="alert" className="ui-inline-error">{error}</p>}
        <div className="ui-dialog__actions"><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={!newOwnerId || searching} loading={busy}>确认转移</Button></div>
      </form>
    </Dialog>
  );
}
