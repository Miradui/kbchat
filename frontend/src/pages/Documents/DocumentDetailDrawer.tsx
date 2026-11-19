import { Download, FileText, FileType, RotateCw, Search, Trash2 } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '../../api/client';
import {
  deleteDocument,
  downloadDocument,
  getDocument,
  getDocumentPreview,
  getKnowledgeBase,
  listDocumentChunks,
  reprocessDocument,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/feedback/EmptyState';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { PdfPreview } from '../../components/pdf/PdfPreview';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { SearchInput } from '../../components/ui/Field';
import { Pagination } from '../../components/ui/Pagination';
import type { DocumentChunk, DocumentItem, DocumentPreviewResponse, KnowledgeBase } from '../../types/api';
import { hasCapability } from '../../utils/access';
import { formatBytes, formatDateTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';
import { tableSourceLabel } from '../../utils/tableSource';
import { DocumentProgress } from './DocumentProgress';
import { DocumentReadingPreview } from './DocumentReadingPreview';
import { PdfTextNotice } from './PdfTextNotice';
import { DocumentVersionDialog } from './DocumentVersionDialog';
import { documentDisplayStatusLabel, documentDisplayStatusTone, isTerminalDocumentStatus } from './documentDisplay';
import { documentFailureCopy, documentStalenessHint } from './documentFailure';
import { documentChatUrl } from '../Chat/documentChatScope';
import { DocumentTextEditor } from './DocumentTextEditor';
import { DocumentOCRCorrection } from './DocumentOCRCorrection';

const CHUNK_PAGE_SIZE = 20;

/**
 * Whether a poll answer carries anything new.
 *
 * The detail endpoint returns a fresh object every 2s even when nothing moved,
 * and replacing the state with it restarted the effects that depended on the
 * document. Comparing the fields the progress UI renders keeps that churn away.
 */
function documentProgressChanged(current: DocumentItem, next: DocumentItem): boolean {
  return current.status !== next.status
    || current.jobStatus !== next.jobStatus
    || current.stage !== next.stage
    || current.progress !== next.progress
    || current.retryCount !== next.retryCount
    || current.errorCode !== next.errorCode
    || current.errorMessage !== next.errorMessage
    || current.nextRetryAt !== next.nextRetryAt
    || current.updatedAt !== next.updatedAt;
}

type DocumentDetailDrawerProps = {
  chunkId?: string;
  documentId: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  onChanged?: () => void;
  onClose: () => void;
};

type DocumentOperation = 'download' | 'reprocess' | 'delete' | null;

export function DocumentDetailDrawer({
  chunkId,
  documentId,
  knowledgeBaseId,
  knowledgeBaseName,
  onChanged,
  onClose,
}: DocumentDetailDrawerProps) {
  const toast = useToast();
  const activeDocumentIdRef = useRef(documentId);
  const mountedRef = useRef(false);
  const mutationRef = useRef<symbol | null>(null);
  const sourceChunkRef = useRef<HTMLElement | null>(null);
  /** Which chunk has already been scrolled to, so focus moves once and not again. */
  const focusedChunkRef = useRef('');
  const [document, setDocument] = useState<DocumentItem | null>(null);
  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [accessError, setAccessError] = useState('');
  const [documentScope, setDocumentScope] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentPreviewResponse | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [chunks, setChunks] = useState<DocumentChunk[]>([]);
  const [chunkQueryDraft, setChunkQueryDraft] = useState('');
  const [chunkQuery, setChunkQuery] = useState('');
  const [chunkPage, setChunkPage] = useState(1);
  const [chunkTotal, setChunkTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [chunksLoading, setChunksLoading] = useState(true);
  const [operation, setOperation] = useState<DocumentOperation>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const [correctingOCR, setCorrectingOCR] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [chunkError, setChunkError] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [chunkAttempt, setChunkAttempt] = useState(0);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const submitting = operation !== null;
  const canDownload = hasCapability(knowledgeBase, 'document.download');
  const canWrite = hasCapability(knowledgeBase, 'content.write');
  activeDocumentIdRef.current = documentId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mutationRef.current = null;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    mutationRef.current = null;
    setOperation(null);
    setConfirmDelete(false);
    setComparing(false);
    setEditingText(false);
    setCorrectingOCR(false);
    setDeleteError('');
    setLoading(true);
    setError('');
    setDocument(null);
    setKnowledgeBase(null);
    setAccessError('');
    setDocumentScope(null);
    setPreview(null);
    setPreviewUrl('');
    setPreviewError('');
    setChunks([]);
    setChunkQueryDraft('');
    setChunkQuery('');
    setChunkPage(1);
    setChunkTotal(0);
    setChunkError('');

    getDocument(documentId)
      .then(async (documentResponse) => {
        if (!mounted) return;
        // A citation deep-link can point at another knowledge base; refuse rather
        // than silently showing content from outside the current scope.
        if (knowledgeBaseId && documentResponse.knowledgeBaseId !== knowledgeBaseId) {
          setError('该文档不属于当前知识库，请从正确的知识库重新打开来源。');
          return;
        }

        setDocument(documentResponse);
        setDocumentScope(knowledgeBaseId ?? '');
        const currentKnowledgeBase = await getKnowledgeBase(documentResponse.knowledgeBaseId).catch(() => {
          if (mounted) setAccessError('暂时无法确认文档操作权限，请重新打开文档重试。');
          return null;
        });
        if (!mounted) return;
        setKnowledgeBase(currentKnowledgeBase);
      })
      .catch((caught) => {
        if (mounted) setError(previewErrorMessage(caught, '文档详情加载失败'));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [documentId, knowledgeBaseId, detailAttempt]);

  // Retry only the preview, preserving the current chunk page and reading position.
  const previewReady = !loading && document?.id === documentId && documentScope === (knowledgeBaseId ?? '');
  useEffect(() => {
    if (!previewReady) return;
    let active = true;
    setPreview(null);
    setPreviewUrl('');
    setPreviewError('');
    void getDocumentPreview(documentId).then(async (response) => {
      if (!active) return;
      setPreview(response);
      if (response.kind === 'file' && canDownload) {
        const blob = await downloadDocument(documentId);
        if (active) setPreviewUrl(URL.createObjectURL(blob));
      }
    }).catch((caught) => {
      if (active) setPreviewError(previewErrorMessage(caught, '文档预览加载失败'));
    });
    return () => { active = false; };
  }, [previewReady, documentId, knowledgeBaseId, canDownload, previewAttempt]);

  // A processing document is polled by its own timer instead of by re-running
  // this effect. The effect used to depend on the document object, so every poll
  // answer restarted it and re-triggered every effect that depended on the
  // document -- including the chunk list, which flashed a skeleton and dropped
  // scroll position, focus and the retry state every 2 seconds.
  const documentPolling = Boolean(document
    && document.id === documentId
    && documentScope === (knowledgeBaseId ?? '')
    && !isTerminalDocumentStatus(document.status)
    && document.jobStatus !== 'cancelled');

  useEffect(() => {
    if (!documentPolling) return;
    let active = true;
    let timer: number;
    const poll = () => {
      getDocument(documentId).then((next) => {
        if (!active) return;
        // Keep the previous object when nothing moved: a new object would
        // re-render the progress UI and re-run effects for no reason.
        setDocument((current) => (current && !documentProgressChanged(current, next) ? current : next));
        timer = window.setTimeout(poll, 2000);
      }).catch((caught) => {
        if (!active) return;
        if (caught instanceof ApiError && (caught.status === 403 || caught.status === 404)) {
          setError(previewErrorMessage(caught, '文档已不可访问。'));
          setDocument(null);
          setKnowledgeBase(null);
          setPreview(null);
          setPreviewUrl('');
          setChunks([]);
        } else {
          // Preserve the content and action errors during a transient read failure.
          timer = window.setTimeout(poll, 2000);
        }
      });
    };
    timer = window.setTimeout(poll, 2000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [documentPolling, documentId, documentScope, knowledgeBaseId]);

  const documentReady = Boolean(document && document.id === documentId && documentScope === (knowledgeBaseId ?? ''));
  // The chunk list follows the document's processing stage, not the detail
  // object: it is refetched when indexing moves on, not on every progress tick.
  const chunkSourceKey = document && document.id === documentId
    ? [document.id, document.status, document.stage ?? '', document.retryCount ?? ''].join(':')
    : '';

  useEffect(() => {
    if (!documentReady) {
      setChunks([]);
      setChunkTotal(0);
      setChunksLoading(false);
      return;
    }

    let mounted = true;
    setChunksLoading(true);
    setChunkError('');

    listDocumentChunks(documentId, {
      chunkId,
      page: chunkPage,
      pageSize: CHUNK_PAGE_SIZE,
      q: chunkQuery,
    })
      .then((response) => {
        if (!mounted) return;
        setChunks(response.items);
        setChunkTotal(response.total);
      })
      .catch((caught) => {
        if (!mounted) return;
        setChunkError(previewErrorMessage(caught, '内容片段加载失败'));
        setChunks([]);
        setChunkTotal(0);
      })
      .finally(() => {
        if (mounted) setChunksLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [chunkId, chunkPage, chunkQuery, chunkSourceKey, documentReady, documentId, chunkAttempt]);

  /**
   * Bring the cited chunk into view and put focus on it.
   *
   * The drawer's own focus handling cannot do this: `useModalFocus` focuses the panel
   * the moment it opens, which is before the chunk request has answered, so there is
   * nothing to focus yet. Hence a second, later focus move -- justified here because
   * the whole point of the deep link is that one chunk, and landing at the top of a
   * long drawer leaves the user to hunt for it.
   *
   * Only ever runs for a deep link (`chunkId` set), and only once per chunk, so it
   * cannot yank focus back after the user has moved on.
   */
  // Preview content sits above the chunks. Wait for its initial layout so a late
  // response cannot push the already-focused citation below the visible area.
  const previewSettled = Boolean(previewError || (preview && (preview.kind !== 'file' || !canDownload || previewUrl)));
  useEffect(() => {
    if (!chunkId || chunksLoading || !previewSettled || focusedChunkRef.current === chunkId) return;
    const target = sourceChunkRef.current;
    if (!target) return;

    focusedChunkRef.current = chunkId;
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Optional call: jsdom has no scrollIntoView, and a missing scroll must not stop
    // the focus move, which is the part that matters for keyboard and screen readers.
    target.scrollIntoView?.({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'center',
    });
    target.focus({ preventScroll: true });
  }, [chunkId, chunks, chunksLoading, previewSettled]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function guard(targetId: string, token: symbol): boolean {
    return mountedRef.current
      && activeDocumentIdRef.current === targetId
      && mutationRef.current === token;
  }

  async function handleReprocess() {
    if (!document || !canWrite || mutationRef.current) return;
    const targetId = document.id;
    const token = Symbol('reprocess-document');
    mutationRef.current = token;
    setOperation('reprocess');
    setError('');

    try {
      const next = await reprocessDocument(targetId);
      if (!guard(targetId, token)) return;
      setDocument(next);
      setChunks([]);
      setChunkTotal(0);
      // Reprocessing changes extracted chunks, not the immutable original file.
      // Keep its preview while the document status is polled to completion.
      toast.success('已开始重新处理文档');
      onChanged?.();
    } catch (caught) {
      if (guard(targetId, token)) setError(previewErrorMessage(caught, '文档重处理失败'));
    } finally {
      if (guard(targetId, token)) {
        mutationRef.current = null;
        setOperation(null);
      }
    }
  }

  async function handleDelete() {
    if (!document || !canWrite || mutationRef.current) return;
    const targetId = document.id;
    const token = Symbol('delete-document');
    mutationRef.current = token;
    setOperation('delete');
    setDeleteError('');

    try {
      await deleteDocument(targetId);
      if (!guard(targetId, token)) return;
      setConfirmDelete(false);
      toast.success('文档已移入回收站');
      onChanged?.();
      onClose();
    } catch (caught) {
      if (guard(targetId, token)) setDeleteError(previewErrorMessage(caught, '文档删除失败'));
    } finally {
      if (guard(targetId, token)) {
        mutationRef.current = null;
        setOperation(null);
      }
    }
  }

  async function handleDownload() {
    if (!document || !canDownload || mutationRef.current) return;
    const targetId = document.id;
    const token = Symbol('download-document');
    mutationRef.current = token;
    setOperation('download');
    setError('');

    try {
      const blob = await downloadDocument(targetId);
      if (!guard(targetId, token)) return;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = document.filename;
      window.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (caught) {
      if (guard(targetId, token)) setError(previewErrorMessage(caught, '文档下载失败'));
    } finally {
      if (guard(targetId, token)) {
        mutationRef.current = null;
        setOperation(null);
      }
    }
  }

  const failure = document ? documentFailureCopy(document) : null;
  const stalenessHint = document ? documentStalenessHint(document) : null;

  function handleChunkSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChunkPage(1);
    setChunkQuery(chunkQueryDraft.trim());
  }

  return (
    <>
      <Drawer
        className="doc-detail"
        onClose={() => {
          if (!submitting) onClose();
        }}
        open
        title="文档详情"
        wide
      >
        {loading ? (
          <LoadingSkeleton announce compact columns={2} rows={6} />
        ) : (
          <>
            {error && <div className="ui-inline-error" role="alert">{error}{!document && <Button variant="link" onClick={() => setDetailAttempt((value) => value + 1)}>重新加载详情</Button>}</div>}
            {document && (
              <>
                <section className="doc-detail__head">
                  <span className="ui-kb-glyph ui-kb-glyph--lg" aria-hidden="true">{document.fileType.toLowerCase() === 'docx' ? <FileType /> : <FileText />}</span>
                  <div className="ui-cell-stack">
                    <strong>{document.filename}</strong>
                    <small>{knowledgeBaseName ?? knowledgeBase?.name ?? document.knowledgeBaseId}</small>
                  </div>
                  <Badge tone={documentDisplayStatusTone(document.status, document.jobStatus)}>
                    {documentDisplayStatusLabel(document.status, document.jobStatus)}
                  </Badge>
                </section>

                <div className={document.status === 'completed' ? 'doc-detail__progress is-complete' : 'doc-detail__progress'}>
                  <DocumentProgress document={document} />
                </div>

                {document.status === 'failed' && failure && (
                  <div
                    className={document.jobStatus === 'cancelled' ? 'ui-muted' : 'ui-inline-error'}
                    role={document.jobStatus === 'cancelled' ? undefined : 'alert'}
                  >
                    <p>{failure.reason}</p>
                    {/* The drawer is where the advice belongs: it has the room the list
                        row does not, and it is where the retry button already is. */}
                    <p>{failure.advice}</p>
                  </div>
                )}

                {document.fileType.toLowerCase() === 'pdf' && <PdfTextNotice summary={document.pdfTextSummary} />}

                {stalenessHint && (
                  <p className="ui-inline-notice" role="note">
                    <span>{stalenessHint}</span>
                    <span className="ui-muted">检索和引用不受影响。</span>
                  </p>
                )}

                <dl className="doc-meta-grid">
                  <div><dt>类型</dt><dd>{document.fileType || '—'}</dd></div>
                  {document.sourcePath && <div><dt>来源路径</dt><dd className="doc-import__path">{document.sourcePath}</dd></div>}
                  {document.tableImport && <div><dt>表格导入设置</dt><dd>{document.tableImport.sheets.map((sheet) => `${sheet.name || 'CSV'}：${sheet.headerRow ? `表头第 ${sheet.headerRow} 行` : '自动表头'}，${sheet.columns ? `第 ${sheet.columns.join('、')} 列` : '全部列'}`).join('；')}</dd></div>}
                  <div><dt>大小</dt><dd>{formatBytes(document.fileSize)}</dd></div>
                  <div><dt>创建</dt><dd>{formatDateTime(document.createdAt)}</dd></div>
                  <div><dt>更新</dt><dd>{formatDateTime(document.updatedAt || document.createdAt)}</dd></div>
                </dl>

                <div className="doc-detail__actions">
                  <Button disabled={submitting} variant="secondary" onClick={() => setComparing(true)}>版本对比</Button>
                  {canDownload && <Button
                    disabled={submitting}
                    leadingIcon={<Download aria-hidden="true" />}
                    loading={operation === 'download'}
                    loadingLabel="下载中"
                    variant="secondary"
                    onClick={() => void handleDownload()}
                  >
                    下载
                  </Button>}
                  {canWrite && <Button
                    disabled={submitting}
                    leadingIcon={<RotateCw aria-hidden="true" />}
                    loading={operation === 'reprocess'}
                    loadingLabel="处理中"
                    variant="secondary"
                    onClick={() => void handleReprocess()}
                  >
                    重新处理
                  </Button>}
                  <span className="ui-toolbar__spacer" />
                  {canWrite && canDownload && document.fileType === 'pdf' && document.pdfTextSummary?.ocr?.completedPages && !document.supersededById ? <Button variant="secondary" disabled={submitting} onClick={() => setCorrectingOCR(true)}>校对 OCR 文本</Button> : null}
                  {canWrite && ['txt', 'md', 'markdown'].includes(document.fileType) && !document.supersededById && <Button variant="secondary" disabled={submitting} onClick={() => setEditingText(true)}>编辑正文</Button>}
                  {document.status === 'completed' && hasCapability(knowledgeBase, 'chat.use') && <Link className="ui-button ui-button--secondary" to={documentChatUrl([document])} onClick={onClose}>针对这份资料提问</Link>}
                  <Link
                    className="ui-button ui-button--ghost"
                    to={`/knowledge-bases/${document.knowledgeBaseId}/documents`}
                  >
                    <span>在知识库中打开</span>
                  </Link>
                  {canWrite && <Button
                    disabled={submitting}
                    leadingIcon={<Trash2 aria-hidden="true" />}
                    variant="ghost"
                    onClick={() => {
                      if (mutationRef.current) return;
                      setDeleteError('');
                      setConfirmDelete(true);
                    }}
                  >
                    删除
                  </Button>}
                </div>
                {accessError && <p className="ui-inline-error" role="alert">{accessError}</p>}

                <section className="doc-detail__section">
                  <div className="ui-panel__head">
                    <h3>预览</h3>
                    <span className="ui-panel__head-note">{preview?.contentType || '原始上传文件'}</span>
                  </div>
                  <div className={`ui-panel__body doc-preview${preview?.kind === 'file' ? ' doc-preview--file' : ''}`}>
                    {previewError ? (
                      <div className="ui-inline-error" role="alert"><p>{previewError}</p><Button onClick={() => setPreviewAttempt((value) => value + 1)} variant="secondary">重试预览</Button></div>
                    ) : !preview ? (
                      <LoadingSkeleton announce compact columns={1} rows={3} />
                    ) : preview.kind === 'text' ? (
                      <DocumentReadingPreview key={documentId} content={preview.content || ''} fileType={preview.fileType} />
                    ) : !canDownload ? (
                      <p className="ui-muted">可阅读下方内容片段；下载原始文件需要编辑者及以上权限。</p>
                    ) : previewUrl ? (
                      preview.fileType.toLowerCase() === 'pdf' || preview.contentType.includes('pdf') ? (
                        <PdfPreview url={previewUrl} filename={preview.filename} initialPage={chunks.find((chunk) => chunk.id === chunkId)?.pageNumber} />
                      ) : (
                        <EmptyState
                          action={<a className="ui-button ui-button--secondary" href={previewUrl} rel="noreferrer" target="_blank"><span>在新标签页打开</span></a>}
                          description="这个文件类型需要用浏览器单独打开。"
                          title="无法内嵌预览"
                        />
                      )
                    ) : (
                      <LoadingSkeleton announce compact columns={1} rows={3} />
                    )}
                  </div>
                </section>

                <section className="doc-detail__section">
                  <div className="ui-panel__head">
                    <h3>{chunkId ? '引用来源片段' : '内容片段'}</h3>
                    {chunkId ? (
                      <span className="ui-panel__head-note">回答实际使用的片段</span>
                    ) : (
                      <form onSubmit={handleChunkSearch} role="search" style={{ flex: '0 1 220px' }}>
                        <SearchInput
                          aria-label="搜索内容片段"
                          onChange={(event) => setChunkQueryDraft(event.target.value)}
                          icon={<Search aria-hidden="true" />}
                          placeholder="搜索片段"
                          value={chunkQueryDraft}
                        />
                      </form>
                    )}
                  </div>
                  <div className="ui-panel__body">
                    {chunkError ? (
                      <div className="ui-inline-error" role="alert"><p>{chunkError}</p><Button onClick={() => setChunkAttempt((value) => value + 1)} variant="secondary">重试片段</Button></div>
                    ) : chunksLoading ? (
                      <LoadingSkeleton announce compact columns={1} rows={4} />
                    ) : chunks.length === 0 ? (
                      <EmptyState
                        description={chunkId
                          ? '可能已重新处理或删除。你仍可查看当前文档内容。'
                          : '文档完成处理后会在这里显示切片。'}
                        title={chunkId ? '未找到该引用片段' : '还没有内容片段'}
                      />
                    ) : (
                      <>
                        <div className="doc-chunks">
                          {chunks.map((chunk) => {
                            const isSource = Boolean(chunkId) && chunk.id === chunkId;
                            return (
                            <article
                              // Named, because focus lands here programmatically: without
                              // a label a screen reader would announce a bare group.
                              aria-label={isSource ? `引用来源片段 #${chunk.chunkIndex}` : undefined}
                              className={isSource ? 'doc-chunk is-source' : 'doc-chunk'}
                              key={chunk.id}
                              ref={isSource ? sourceChunkRef : undefined}
                              // -1, not 0: reachable for the focus move below but kept out
                              // of the tab order, so tabbing through the drawer is unchanged.
                              tabIndex={isSource ? -1 : undefined}
                            >
                              <header>
                                <strong>#{chunk.chunkIndex}</strong>
                                {isSource && <Badge tone="accent">引用来源</Badge>}
                                {chunk.metadata?.textSource === 'ocr' && <Badge tone="neutral">OCR 识别文本</Badge>}
                                {chunk.metadata?.textSource === 'ocr_corrected' && <Badge tone="neutral">人工校对 OCR 文本</Badge>}
                                <span className="ui-muted">
                                  {chunk.tokenCount} 词元{chunk.pageNumber ? ` · p.${chunk.pageNumber}` : ''}
                                  {chunk.metadata?.table ? ` · ${tableSourceLabel(chunk.metadata.table as import('../../types/api').TableSource)}` : ''}
                                </span>
                              </header>
                              <p>{chunk.content}</p>
                            </article>
                            );
                          })}
                        </div>
                        {!chunkId && (
                          <Pagination
                            onPageChange={setChunkPage}
                            page={chunkPage}
                            pageSize={CHUNK_PAGE_SIZE}
                            total={chunkTotal}
                          />
                        )}
                      </>
                    )}
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </Drawer>

      {comparing && <DocumentVersionDialog documentId={documentId} key={documentId} onClose={() => setComparing(false)} />}
      {editingText && document && <DocumentTextEditor key={documentId} document={document} onClose={() => { setEditingText(false); setDetailAttempt((value) => value + 1); }} onSaved={() => onChanged?.()} />}
      {correctingOCR && document && <DocumentOCRCorrection key={documentId} document={document} onClose={() => { setCorrectingOCR(false); setDetailAttempt((value) => value + 1); }} onSaved={() => onChanged?.()} />}

      {confirmDelete && document && (
        <ConfirmDialog
          busy={submitting}
          confirmLabel="删除"
          description={`确认删除“${document.filename}”？文档会进入回收站，可随时恢复。`}
          error={deleteError}
          onCancel={() => {
            setDeleteError('');
            setConfirmDelete(false);
          }}
          onConfirm={handleDelete}
          title="删除文档"
        />
      )}
    </>
  );
}

function previewErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) {
    if (caught.code === 'DOCUMENT_FILE_NOT_FOUND') return '原始文件不存在，无法下载或预览。';
    if (caught.code === 'FILE_TOO_LARGE_FOR_PREVIEW') return '文件过大，无法在线预览，请下载后查看。';
  }
  return getErrorMessage(caught, fallback);
}
