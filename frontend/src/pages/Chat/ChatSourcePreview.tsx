import { Download, FileText, FileType, LocateFixed, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { downloadDocument, getDocument, getDocumentPreview } from '../../api/resources';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { PdfPreview } from '../../components/pdf/PdfPreview';
import { RenderBoundary } from '../../components/feedback/RenderBoundary';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { IconButton } from '../../components/ui/IconButton';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import type { Citation, DocumentItem, DocumentPreviewResponse } from '../../types/api';
import { downloadBlob } from '../../utils/download';
import { getErrorMessage } from '../../utils/errors';
import { locateCitation, normalizeSourceText, rangeFromByteOffsets } from './citationLocation';
import { tableSourceLabel } from '../../utils/tableSource';

type PreviewState = {
  document: DocumentItem;
  preview: DocumentPreviewResponse;
  file: Blob | null;
  url: string;
};

export function ChatSourcePreview({ citation, index, knowledgeBaseId, canDownload = true, onClose }: {
  citation: Citation;
  index: number;
  knowledgeBaseId: string;
  canDownload?: boolean;
  onClose: () => void;
}) {
  const overlay = useMediaQuery('(max-width: 1599px)');
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const matchRef = useRef<HTMLElement>(null);
  const epoch = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const pageNumber = Number.isInteger(citation.pageNumber) && Number(citation.pageNumber) > 0 ? citation.pageNumber : null;

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    epoch.current += 1;
    setState(null);
    setLoading(true);
    setError('');
    setDownloadError('');
    setDownloading(false);

    async function load() {
      try {
        const document = await getDocument(citation.documentId);
        if (!active) return;
        if (document.knowledgeBaseId !== knowledgeBaseId) {
          setError('该文档不属于当前会话的知识库，请重新选择来源。');
          return;
        }
        const preview = await getDocumentPreview(citation.documentId);
        if (!active) return;
        const file = preview.kind === 'file' && canDownload ? await downloadDocument(citation.documentId) : null;
        if (!active) return;
        if (file) objectUrl = URL.createObjectURL(file);
        setState({ document, preview, file, url: objectUrl });
      } catch (caught) {
        if (active) setError(getErrorMessage(caught, '原文加载失败，请稍后重试。'));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
      epoch.current += 1;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [citation.documentId, knowledgeBaseId, canDownload, attempt]);

  // Move focus on an explicit selection, never when a slow preview response arrives.
  useEffect(() => {
    if (!overlay) panelRef.current?.focus({ preventScroll: true });
  }, [citation.documentId, citation.chunkId, overlay]);

  const content = normalizeSourceText(state?.preview.content ?? '');
  const sourceRow = citation.table ? state?.preview.tableRows?.find((row) => row.sheetName === citation.table?.sheetName && row.rowStart === citation.table.rowStart && row.rowEnd === citation.table.rowEnd && row.headerRow === citation.table.headerRow) : undefined;
  const tableMatch = sourceRow ? rangeFromByteOffsets(content, sourceRow.startOffset, sourceRow.endOffset) : null;
  const match = state?.preview.kind === 'text' ? citation.table ? tableMatch : locateCitation(content, citation) : null;
  const matchStart = match?.start ?? -1;
  useEffect(() => {
    if (!loading) matchRef.current?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  }, [loading, citation.chunkId, matchStart]);

  async function download() {
    if (!canDownload || !state || downloading) return;
    const operation = epoch.current;
    setDownloading(true);
    setDownloadError('');
    try {
      const file = state.file ?? await downloadDocument(citation.documentId);
      if (epoch.current === operation) downloadBlob(file, state.document.filename);
    } catch (caught) {
      if (epoch.current === operation) setDownloadError(getErrorMessage(caught, '下载原文失败'));
    } finally {
      if (epoch.current === operation) setDownloading(false);
    }
  }

  const actions = canDownload ? <IconButton disabled={!state || downloading} label={downloading ? '正在下载原文' : '下载原文'} onClick={() => void download()}><Download aria-hidden="true" /></IconButton> : null;
  const body = (
    <div className="chat-preview__body">
      <div className="chat-preview__info">
        {citation.filename.toLowerCase().endsWith('.docx') ? <FileType aria-hidden="true" /> : <FileText aria-hidden="true" />}
        <div>
          <h3>{state?.document.filename ?? citation.filename}</h3>
          <p>{citation.knowledgeBaseName && `${citation.knowledgeBaseName} · `}来源 {index} · {tableSourceLabel(citation.table) || (pageNumber ? `第 ${pageNumber} 页` : '未提供页码')}</p>
        </div>
      </div>
      <details className="chat-preview__excerpt" open>
        <summary>本次回答引用的内容</summary>
        <blockquote>{citation.content}</blockquote>
      </details>
      {state?.document.fileType === 'xlsx' && <p className="ui-muted">工作表按首个非空行识别表头。公式仅显示文件已保存的结果，缺少缓存值的单元格为空；不会重新计算。</p>}
      {downloadError && <p className="ui-inline-error" role="alert">{downloadError}</p>}
      {loading ? <LoadingSkeleton rows={5} /> : error ? (
        <div className="chat-preview__error">
          <p role="alert">{error}</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>重新加载原文</Button>
        </div>
      ) : state?.preview.kind === 'text' ? (
        <>
          <div className="chat-preview__toolbar">
            <span>文档原文</span>
            {match ? <Button leadingIcon={<LocateFixed aria-hidden="true" />} onClick={() => matchRef.current?.scrollIntoView?.({ block: 'center', behavior: 'auto' })} variant="ghost">定位到引用</Button>
              : <small>可对照上方摘录阅读原文</small>}
          </div>
          <pre aria-label="文档原文" className="chat-preview__text" tabIndex={0}>
            {match ? <>{content.slice(0, match.start)}<mark ref={matchRef}>{content.slice(match.start, match.end)}</mark>{content.slice(match.end)}</> : content || '文档没有可预览的文本内容。'}
          </pre>
        </>
      ) : !canDownload && state?.preview.kind === 'file' ? (
        <p className="ui-muted">可阅读上方引用内容；下载原始文件需要编辑者及以上权限。</p>
      ) : state?.url && state.preview.fileType.toLowerCase() === 'pdf' ? (
        <RenderBoundary local resetKey={state.url}><PdfPreview url={state.url} filename={state.document.filename} initialPage={pageNumber} highlight={{ id: citation.chunkId, content: citation.content }} /></RenderBoundary>
      ) : <p className="chat-preview__error">暂不支持直接预览此格式，可下载原文查看。</p>}
    </div>
  );

  if (overlay) {
    return <Drawer headerActions={actions} onClose={onClose} open title="原文预览" wide>{body}</Drawer>;
  }
  return (
    <aside aria-busy={loading || undefined} aria-labelledby={titleId} className="chat-preview" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    }} ref={panelRef} tabIndex={-1}>
      <header className="chat-preview__head">
        <h2 id={titleId}>原文预览</h2>
        {actions}
        <IconButton label="关闭原文预览" onClick={onClose}><X aria-hidden="true" /></IconButton>
      </header>
      {body}
    </aside>
  );
}
