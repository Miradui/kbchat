import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { downloadDocument, getPDFCorrection, savePDFCorrection } from '../../api/resources';
import type { PDFCorrection, PDFCorrectionPage } from '../../api/resources';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { Field, Select, Textarea } from '../../components/ui/Field';
import { PdfPreview } from '../../components/pdf/PdfPreview';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { getErrorMessage } from '../../utils/errors';
import type { DocumentItem } from '../../types/api';

export function DocumentOCRCorrection({ document, onClose, onSaved }: { document: DocumentItem; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<PDFCorrection | null>(null);
  const [pages, setPages] = useState<PDFCorrectionPage[]>([]);
  const [selected, setSelected] = useState(0);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [discard, setDiscard] = useState(false);
  const [result, setResult] = useState<DocumentItem | null>(null);
  const request = useRef<{ key: string; requestId: string } | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const changed = pages.filter((page) => page.content !== data?.pages.find((original) => original.pageNumber === page.pageNumber)?.content);
  const dirty = changed.length > 0 && !result;
  useUnsavedChangesWarning(dirty);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController(); let objectUrl = '';
    setLoading(true); setError('');
    void Promise.all([getPDFCorrection(document.id, abort.signal), downloadDocument(document.id)]).then(([loaded, file]) => {
      if (!abort.signal.aborted) { objectUrl = URL.createObjectURL(file); setUrl(objectUrl); setData(loaded); setPages(loaded.pages); setSelected(0); }
    }).catch((caught) => { if (!abort.signal.aborted) setError(getErrorMessage(caught, '校对资料加载失败')); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [document.id, attempt]);
  function close() { if (pending.current) return; if (dirty) setDiscard(true); else onClose(); }
  async function save() {
    if (pending.current || !data || !changed.length) return;
    pending.current = true; setBusy(true); setError('');
    const key = JSON.stringify(changed);
    if (request.current?.key !== key) request.current = { key, requestId: crypto.randomUUID() };
    try {
      const saved = await savePDFCorrection(document.id, { requestId: request.current.requestId, revision: data.revision, pages: changed });
      if (mounted.current) { setResult(saved); onSaved(); }
    } catch (caught) { if (mounted.current) setError(getErrorMessage(caught, '保存结果未确认，可重试；校对内容已保留。')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const page = pages[selected];
  const invalid = changed.some((value) => !value.content.trim() || new TextEncoder().encode(value.content).length > 1048576);
  return <>
    <Dialog open title="OCR 原图对照与校对" description="选择 OCR 页，核对原图后修改文字。保存为新版本，原始 PDF 图像保持不变。" className="document-version-dialog" onClose={close}>
      {loading ? <p role="status">正在读取已发布识别文本和原图…</p> : result ? <>
        <p role="status">校对版已保存，处理完成后可用于问答。</p><Link className="ui-button ui-button--primary" to={`/documents?documentId=${result.id}`} onClick={onClose}>查看校对版本</Link>
      </> : <>
        {page && <>
          <Field label="校对页面"><Select aria-label="校对页面" value={selected} disabled={busy} onChange={(event) => setSelected(Number(event.target.value))}>{pages.map((value, index) => <option key={value.pageNumber} value={index}>第 {value.pageNumber} 页 · {value.textSource === 'ocr_corrected' ? '人工校对' : '机器识别'}</option>)}</Select></Field>
          <div className="doc-ocr-split">
            <PdfPreview url={url} filename={document.filename} initialPage={page.pageNumber} lockPage />
            <Field htmlFor="ocr-page-content" label={`第 ${page.pageNumber} 页识别文本`}>
              <Textarea id="ocr-page-content" rows={22} disabled={busy} value={page.content} onChange={(event) => setPages((current) => current.map((value, index) => index === selected ? { ...value, content: event.target.value } : value))} />
            </Field>
          </div>
          <p>已修改 {changed.length} 页；每页最多 1 MiB，全部文本最多 8 MiB。</p>
        </>}
        {error && <p role="alert" className="ui-inline-error">{error}{!data && <Button variant="link" onClick={() => setAttempt((value) => value + 1)}>重新读取</Button>}</p>}
        <div className="ui-dialog__actions"><Button variant="secondary" disabled={busy} onClick={close}>取消</Button><Button disabled={!dirty || invalid} loading={busy} onClick={() => void save()}>保存校对版本</Button></div>
      </>}
    </Dialog>
    {discard && <ConfirmDialog title="放弃未保存的校对？" description="关闭后，这次校对内容将丢失。" confirmLabel="放弃校对" onCancel={() => setDiscard(false)} onConfirm={onClose} />}
  </>;
}
