import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { getEditableDocumentText, saveDocumentTextRevision } from '../../api/resources';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { getErrorMessage } from '../../utils/errors';
import type { DocumentItem } from '../../types/api';
import { DocumentReadingPreview } from './DocumentReadingPreview';

export function DocumentTextEditor({ document, onClose, onSaved }: { document: DocumentItem; onClose: () => void; onSaved: () => void }) {
  const [original, setOriginal] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [result, setResult] = useState<DocumentItem | null>(null);
  const request = useRef<{ content: string; requestId: string } | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const dirty = original !== null && content !== original && !result;
  useUnsavedChangesWarning(dirty);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController(); setLoading(true); setError('');
    void getEditableDocumentText(document.id, abort.signal).then((data) => {
      if (!abort.signal.aborted) { setOriginal(data.content); setContent(data.content); }
    }).catch((caught) => { if (!abort.signal.aborted) setError(getErrorMessage(caught, '正文加载失败')); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; abort.abort(); };
  }, [document.id, attempt]);
  function close() { if (pending.current) return; if (dirty) setDiscard(true); else onClose(); }
  async function save() {
    if (pending.current || !dirty || !content.trim()) return;
    pending.current = true; setBusy(true); setError('');
    if (!request.current || request.current.content !== content) request.current = { content, requestId: crypto.randomUUID() };
    try {
      const saved = await saveDocumentTextRevision(document.id, request.current);
      if (mounted.current) { setResult(saved); onSaved(); }
    } catch (caught) { if (mounted.current) setError(getErrorMessage(caught, '保存结果未确认，可重试；当前编辑内容已保留。')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const bytes = new TextEncoder().encode(content).length;
  return createPortal(<>
    <Dialog open title={`编辑 ${document.filename}`} description="保存为新版本，原文和旧回答依据保持可读。" className="document-version-dialog" onClose={close}>
      {loading ? <p role="status">正在读取完整正文…</p> : result ? <>
        <p role="status">新版本已保存，正在进入文档处理流程。</p>
        <Link className="ui-button ui-button--primary" to={`/documents?documentId=${result.id}`} onClick={onClose}>查看新版本</Link>
      </> : <>
        {original !== null && <>
          <Button variant="ghost" onClick={() => setPreview((value) => !value)}>{preview ? '继续编辑' : '预览正文'}</Button>
          {preview ? <DocumentReadingPreview content={content} fileType={document.fileType} /> : <textarea aria-label="文档正文编辑" className="ui-input" rows={18} disabled={busy} value={content} onChange={(event) => setContent(event.target.value)} />}
          <p>{bytes.toLocaleString()} / 1,048,576 字节</p>
        </>}
        {error && <p role="alert" className="ui-inline-error">{error}{original === null && <Button variant="link" onClick={() => setAttempt((value) => value + 1)}>重新读取</Button>}</p>}
        <div className="ui-dialog__actions"><Button variant="secondary" disabled={busy} onClick={close}>取消</Button><Button loading={busy} disabled={!dirty || !content.trim() || bytes > 1048576} onClick={() => void save()}>保存新版本</Button></div>
      </>}
    </Dialog>
    {discard && <ConfirmDialog title="放弃未保存的修改？" description="关闭后，这次正文修改将丢失。" confirmLabel="放弃修改" onCancel={() => setDiscard(false)} onConfirm={onClose} />}
  </>, window.document.body);
}
