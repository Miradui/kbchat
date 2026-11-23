import { useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Checkbox } from '../../components/ui/Field';
import { documentChatUrl } from '../Chat/documentChatScope';
import type { ImportBatch } from './DocumentImportContext';
import { documentDisplayStatusLabel } from './documentDisplay';

export function ImportBatchChat({ batch, onNavigate }: { batch: ImportBatch; onNavigate: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const fieldId = useId();
  const entries = batch.tasks ?? batch.documents.map((document) => ({ document, paused: false, error: '' }));
  const usable = entries.filter(({ document, paused, error: taskError }) => document.status === 'completed' && document.jobStatus !== 'cancelled' && !paused && !taskError);
  const pendingItems = batch.pendingItems ?? [];
  const allReady = entries.length > 0 && usable.length === entries.length && pendingItems.length === 0;
  const withinLimit = entries.length <= 20 && new Set(entries.map(({ document }) => document.knowledgeBaseId)).size <= 5;
  const chosen = entries.filter(({ document }) => selected.includes(document.id));
  const bases = [...new Set(entries.map(({ document }) => document.knowledgeBaseId))];

  function submit() {
    // Recheck current task state at activation; never silently drop a chosen item.
    if (!chosen.length || chosen.length !== selected.length || chosen.some((entry) => !usable.includes(entry))) {
      setError('请选择已处理完成且可访问的资料；状态变化的资料请取消勾选后重新选择。');
      return;
    }
    if (chosen.length > 20 || new Set(chosen.map(({ document }) => document.knowledgeBaseId)).size > 5) {
      setError('请选择最多 5 个知识库中的 1–20 份文档。');
      return;
    }
    onNavigate(documentChatUrl(chosen.map(({ document }) => document)));
    setOpen(false);
  }

  return <div className="import-batch-chat">
    <p>{allReady ? `${entries.length} 份资料已可用于问答。` : `本次导入 ${entries.length + pendingItems.length} 份资料，${usable.length} 份可用于问答。尚未可用的资料不会加入提问范围，请等待处理或明确选择子集。`}</p>
    {!withinLimit && <p>一次最多选择 20 份文档、5 个知识库，请选择本次导入中的一部分资料。</p>}
    {allReady && withinLimit
      ? <Button onClick={() => onNavigate(documentChatUrl(entries.map(({ document }) => document)))}>{entries.length === 1 ? '问这份资料' : '问本次导入'}</Button>
      : <Button onClick={() => { setSelected([]); setError(''); setOpen(true); }} variant="secondary">选择本次导入中的资料</Button>}
    {allReady && bases.length === 1 && <Button onClick={() => onNavigate(`/chat?knowledgeBaseId=${encodeURIComponent(bases[0])}`)} variant="link">在整个知识库提问</Button>}
    <Dialog description="这里只展示本次导入。勾选 1–20 份已处理完成的资料，最多涉及 5 个知识库。进入聊天后仍可编辑问题。" onClose={() => setOpen(false)} open={open} title="选择本次导入的提问资料">
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <fieldset className="import-batch-chat__items">
          <legend>本次导入的完整清单</legend>
          {entries.map((entry, index) => {
            const { document, paused, error: taskError } = entry;
            const available = usable.includes(entry);
            const checkboxId = `${fieldId}-${index}`;
            return <div className="import-batch-chat__item" key={document.id}>
              <Checkbox aria-describedby={`${checkboxId}-status`} checked={selected.includes(document.id)} disabled={!available && !selected.includes(document.id)} id={checkboxId} name="documents" onChange={(event) => { setError(''); setSelected((current) => event.target.checked ? [...current, document.id] : current.filter((id) => id !== document.id)); }} value={document.id} />
              <label htmlFor={checkboxId}>{document.filename}</label>
              <small id={`${checkboxId}-status`}>{paused ? '状态待确认，暂不可选' : (documentDisplayStatusLabel(document.status, document.jobStatus) || '状态未知，暂不可选')}{taskError ? ` · ${taskError}` : ''}</small>
            </div>;
          })}
          {pendingItems.map((item) => <p key={item.key}>{item.name} · {item.error || '尚未上传完成，暂不可选'}</p>)}
        </fieldset>
        <p>已选 {selected.length} 份资料</p>
        {error && <p className="ui-inline-error" role="alert">{error}</p>}
        <div className="ui-dialog__actions"><Button onClick={() => setOpen(false)} variant="secondary">取消</Button><Button type="submit">问所选资料</Button></div>
      </form>
    </Dialog>
  </div>;
}
