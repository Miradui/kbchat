import { useEffect, useRef, useState } from 'react';
import { compareDocumentVersions, listDocumentVersions } from '../../api/resources';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Select } from '../../components/ui/Field';
import type { DocumentCompareResponse, DocumentVersion } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { formatDateTime } from '../../utils/format';

export function DocumentVersionDialog({ documentId, initialBaseId, onClose }: { documentId: string; initialBaseId?: string; onClose: () => void }) {
  const [items, setItems] = useState<DocumentVersion[]>([]);
  const [base, setBase] = useState(''); const [head, setHead] = useState(documentId);
  const [result, setResult] = useState<DocumentCompareResponse | null>(null);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setResult(null);
    void listDocumentVersions(documentId, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setItems(data.items); setHead(documentId);
      const current = data.items.findIndex((item) => item.id === documentId);
      setBase(initialBaseId && data.items.some((item) => item.id === initialBaseId) ? initialBaseId : data.items[current > 0 ? current - 1 : 1]?.id ?? '');
    }).catch((caught) => { if (!controller.signal.aborted) setError(getErrorMessage(caught, '版本加载失败。')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); pending.current?.abort(); };
  }, [documentId, initialBaseId, attempt]);
  function changed() { pending.current?.abort(); setBusy(false); setResult(null); setError(''); }
  async function compare() {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setBusy(true); setResult(null); setError('');
    try { const data = await compareDocumentVersions(head, base, controller.signal); if (!controller.signal.aborted) setResult(data); }
    catch (caught) { if (!controller.signal.aborted) setError(getErrorMessage(caught, '版本对比失败，请重试。')); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <Dialog open title="文档版本对比" description="比较解析后的文本，标记新增和删除行；不比较 PDF／Word 版式。" className="document-version-dialog" onClose={onClose}>
    {loading ? <p role="status">正在加载版本…</p> : <>
      {items.length < 2 && !error && <p>当前文档尚无可比较的历史版本。通过“替换文档”上传新版本后可在这里对比。</p>}
      <div className="document-version-selectors">
        <Field label="基准版本"><Select aria-label="基准版本" value={base} onChange={(event) => { changed(); setBase(event.target.value); }}>
          <option value="">选择基准版本</option>{items.map((item, index) => <option key={item.id} value={item.id}>版本 {index + 1} · {item.filename} · {formatDateTime(item.createdAt)}</option>)}
        </Select></Field>
        <Field label="对比版本"><Select aria-label="对比版本" value={head} onChange={(event) => { changed(); setHead(event.target.value); }}>
          {items.map((item, index) => <option key={item.id} value={item.id}>版本 {index + 1} · {item.filename} · {formatDateTime(item.createdAt)}</option>)}
        </Select></Field>
      </div>
    </>}
    {error && <p role="alert" className="ui-inline-error">{error}{!items.length && <Button variant="link" onClick={() => setAttempt(attempt + 1)}>重新加载版本</Button>}</p>}
    {result && <>
      <p role="status">{result.addedLines || result.removedLines ? `新增 ${result.addedLines} 行，删除 ${result.removedLines} 行` : '两个版本的解析文本相同。'}</p>
      <div className="document-diff" aria-label="文本差异">
        {result.lines.map((line, index) => <div key={index} className={`document-diff__line is-${line.kind}`}>
          <span className="document-diff__numbers" aria-label={`基准行 ${line.baseLine ?? '无'}，对比行 ${line.headLine ?? '无'}`}>{line.baseLine ?? '–'} / {line.headLine ?? '–'}</span>
          <span aria-label={line.kind === 'add' ? '新增' : line.kind === 'remove' ? '删除' : '相同'}>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
          <span className="document-diff__text">{line.content || ' '}</span>
        </div>)}
      </div>
    </>}
    <div className="ui-dialog__actions"><Button variant="secondary" onClick={onClose}>关闭对比</Button>
      <Button disabled={loading || !base || !head || base === head} loading={busy} onClick={() => void compare()}>比较文本</Button></div>
  </Dialog>;
}
