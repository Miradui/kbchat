import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Link } from 'react-router-dom';

import { ApiError } from '../../api/client';
import {
  deleteDocument,
  downloadDocument,
  getDocument,
  getDocumentPreview,
  listDocumentChunks,
  reprocessDocument,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { useToast } from '../../components/feedback/ToastProvider';
import { IconButton } from '../../components/ui/IconButton';
import { useModalFocus } from '../../components/ui/useModalFocus';
import type { DocumentChunk, DocumentItem, DocumentPreviewResponse } from '../../types/api';
import { getDocumentProcessingErrorMessage, getErrorMessage } from '../../utils/errors';
import { DocumentProgress } from './DocumentProgress';
import {
  documentStatusClass,
  documentStatusLabel,
  formatDocumentBytes,
  formatDocumentDateTime,
} from './documentDisplay';

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
  const [document, setDocument] = useState<DocumentItem | null>(null);
  const [documentScope, setDocumentScope] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentPreviewResponse | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [chunks, setChunks] = useState<DocumentChunk[]>([]);
  const [chunkQueryDraft, setChunkQueryDraft] = useState('');
  const [chunkQuery, setChunkQuery] = useState('');
  const [chunkPage, setChunkPage] = useState(1);
  const [chunkPageSize] = useState(20);
  const [chunkTotal, setChunkTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [chunksLoading, setChunksLoading] = useState(true);
  const [operation, setOperation] = useState<DocumentOperation>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [chunkError, setChunkError] = useState('');
  const submitting = operation !== null;
  const panelRef = useModalFocus<HTMLElement>(true, () => {
    if (!submitting) onClose();
  });
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
    setDeleteError('');
    setLoading(true);
    setError('');
    setDocument(null);
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
        if (!mounted) {
          return;
        }
        if (knowledgeBaseId && documentResponse.knowledgeBaseId !== knowledgeBaseId) {
          setError('该文档不属于当前知识库，请从正确的知识库重新打开来源。');
          return;
        }

        setDocument(documentResponse);
        setDocumentScope(knowledgeBaseId ?? '');
        const previewResponse = await getDocumentPreview(documentId).catch((err) => {
        if (mounted) {
          setPreviewError(errorMessage(err, '文档预览加载失败'));
        }
        return null;
        });
        if (!mounted) {
          return;
        }
        setPreview(previewResponse);
        if (previewResponse?.kind === 'file') {
          try {
            const blob = await downloadDocument(documentId);
            if (mounted) {
              setPreviewUrl(URL.createObjectURL(blob));
            }
          } catch (err) {
            if (mounted) {
              setPreviewError(errorMessage(err, '文件预览加载失败'));
            }
          }
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '文档详情加载失败'));
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [documentId, knowledgeBaseId]);

  useEffect(() => {
    if (
      !document
      || document.id !== documentId
      || documentScope !== (knowledgeBaseId ?? '')
    ) {
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
      pageSize: chunkPageSize,
      q: chunkQuery,
    })
      .then((response) => {
        if (!mounted) {
          return;
        }
        setChunks(response.items);
        setChunkTotal(response.total);
      })
      .catch((err) => {
        if (mounted) {
          setChunkError(errorMessage(err, 'Chunks 加载失败'));
          setChunks([]);
          setChunkTotal(0);
        }
      })
      .finally(() => {
        if (mounted) {
          setChunksLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [chunkId, chunkPage, chunkPageSize, chunkQuery, document, documentId, documentScope, knowledgeBaseId]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleReprocess() {
    if (!document || mutationRef.current) {
      return;
    }

    setOperation('reprocess');
    setError('');
    const targetDocumentId = document.id;
    const operation = Symbol('reprocess-document');
    mutationRef.current = operation;

    try {
      const nextDocument = await reprocessDocument(targetDocumentId);
      if (
        !mountedRef.current
        || activeDocumentIdRef.current !== targetDocumentId
        || mutationRef.current !== operation
      ) {
        return;
      }
      setDocument(nextDocument);
      setChunks([]);
      setChunkTotal(0);
      setPreview(null);
      setPreviewUrl('');
      setPreviewError('');
      toast.success('已开始重新处理文档');
      onChanged?.();
    } catch (err) {
      if (
        mountedRef.current
        && activeDocumentIdRef.current === targetDocumentId
        && mutationRef.current === operation
      ) {
        setError(errorMessage(err, '文档重处理失败'));
      }
    } finally {
      if (
        mountedRef.current
        && activeDocumentIdRef.current === targetDocumentId
        && mutationRef.current === operation
      ) {
        mutationRef.current = null;
        setOperation(null);
      }
    }
  }

  async function handleDelete() {
    if (!document || mutationRef.current) {
      return;
    }

    setOperation('delete');
    setDeleteError('');
    const targetDocumentId = document.id;
    const operation = Symbol('delete-document');
    mutationRef.current = operation;

    try {
      await deleteDocument(targetDocumentId);
      if (
        !mountedRef.current
        || activeDocumentIdRef.current !== targetDocumentId
        || mutationRef.current !== operation
      ) {
        return;
      }
      setConfirmDelete(false);
      toast.success('文档已移入回收站');
      onChanged?.();
      onClose();
    } catch (err) {
      if (
        mountedRef.current
        && activeDocumentIdRef.current === targetDocumentId
        && mutationRef.current === operation
      ) {
        setDeleteError(errorMessage(err, '文档删除失败'));
      }
    } finally {
      if (
        mountedRef.current
        && activeDocumentIdRef.current === targetDocumentId
        && mutationRef.current === operation
      ) {
        mutationRef.current = null;
        setOperation(null);
      }
    }
  }

  function handleChunkSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChunkPage(1);
    setChunkQuery(chunkQueryDraft.trim());
  }

  async function handleDownload() {
    if (!document || mutationRef.current) {
      return;
    }

    setOperation('download');
    setError('');
    const targetDocumentId = document.id;
    const operation = Symbol('download-document');
    mutationRef.current = operation;

    try {
      const blob = await downloadDocument(targetDocumentId);
      if (
        !mountedRef.current
        || activeDocumentIdRef.current !== targetDocumentId
        || mutationRef.current !== operation
      ) {
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = document.filename;
      window.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      if (
        mountedRef.current
        && activeDocumentIdRef.current === targetDocumentId
        && mutationRef.current === operation
      ) {
        setError(errorMessage(err, '文档下载失败'));
      }
    } finally {
      if (
        mountedRef.current
        && activeDocumentIdRef.current === targetDocumentId
        && mutationRef.current === operation
      ) {
        mutationRef.current = null;
        setOperation(null);
      }
    }
  }

  function openDeleteConfirmation() {
    if (mutationRef.current) {
      return;
    }
    setDeleteError('');
    setConfirmDelete(true);
  }

  const chunkTotalPages = Math.max(1, Math.ceil(chunkTotal / chunkPageSize));

  return createPortal(
    <>
      <aside
        className="drawer-backdrop"
        role="presentation"
        onClick={(event) => {
          if (event.target === event.currentTarget && !submitting) {
            onClose();
          }
        }}
      >
        <section className="drawer-panel document-detail-drawer" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="document-detail-title" tabIndex={-1}>
          <header>
            <div>
              <h2 id="document-detail-title">文档详情</h2>
              <p className="muted-text">查看文档状态、预览内容和内容片段。</p>
            </div>
            <IconButton disabled={submitting} label="关闭" onClick={onClose}>
              <X aria-hidden="true" />
            </IconButton>
          </header>

          {loading ? (
            <LoadingSkeleton rows={6} columns={2} compact announce />
          ) : (
            <>
              {error && <p className="drawer-error-text" role="alert">{error}</p>}
              {document ? (
                <div className="document-detail-content">
                  <section className="document-detail-summary">
                    <div className="document-detail-title">
                      <span className="document-file-icon" aria-hidden="true" />
                      <div>
                        <strong>{document.filename}</strong>
                        <span>{knowledgeBaseName ?? document.knowledgeBaseId}</span>
                      </div>
                    </div>
                    <span className={`status-pill status-${documentStatusClass(document.status)}`}>
                      {documentStatusLabel(document.status)}
                    </span>
                  </section>

                  <DocumentProgress document={document} />

                  <dl className="document-meta-grid">
                    <div>
                      <dt>类型</dt>
                      <dd>{document.fileType || '-'}</dd>
                    </div>
                    <div>
                      <dt>大小</dt>
                      <dd>{formatDocumentBytes(document.fileSize)}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatDocumentDateTime(document.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>更新时间</dt>
                      <dd>{formatDocumentDateTime(document.updatedAt || document.createdAt)}</dd>
                    </div>
                  </dl>

                  {document.errorMessage && (
                    <p className="document-alert error-text" role="alert">
                      {getDocumentProcessingErrorMessage(document.errorMessage)}
                    </p>
                  )}

                  <div className="document-detail-actions">
                    <Link
                      aria-disabled={submitting}
                      className="secondary-link"
                      tabIndex={submitting ? -1 : undefined}
                      to={`/knowledge-bases/${document.knowledgeBaseId}/documents`}
                      onClick={(event) => {
                        if (submitting) {
                          event.preventDefault();
                        }
                      }}
                      >
                      打开处理详情
                    </Link>
                    <button className="secondary-button" type="button" onClick={() => void handleDownload()} disabled={submitting}>
                      {operation === 'download' ? '下载中...' : '下载'}
                    </button>
                    <button className="secondary-button" type="button" onClick={() => void handleReprocess()} disabled={submitting}>
                      {operation === 'reprocess' ? '处理中...' : '重处理'}
                    </button>
                    <button className="danger-button" type="button" onClick={openDeleteConfirmation} disabled={submitting}>
                      删除
                    </button>
                  </div>

                  <section className="document-preview-section">
                    <header>
                      <div>
                        <h3>预览</h3>
                        <p className="muted-text">{preview?.contentType || '读取原始上传文件'}</p>
                      </div>
                    </header>
                    {previewError ? (
                      <div className="empty-state" role="alert">{previewError}</div>
                    ) : !preview ? (
                      <LoadingSkeleton rows={3} columns={1} compact announce />
                    ) : preview.kind === 'text' ? (
                      <pre className="document-text-preview">{preview.content || ''}</pre>
                    ) : previewUrl ? (
                      preview.fileType.toLowerCase() === 'pdf' || preview.contentType.includes('pdf') ? (
                        <iframe className="document-file-preview" src={previewUrl} title={`${preview.filename} 预览`} />
                      ) : (
                        <div className="empty-state">
                          该文件类型使用浏览器打开预览。
                          <a className="secondary-link" href={previewUrl} target="_blank" rel="noreferrer">
                            打开文件
                          </a>
                        </div>
                      )
                    ) : (
                      <LoadingSkeleton rows={3} columns={1} compact announce />
                    )}
                  </section>

                  <section className="document-chunk-section">
                    <header>
                      <div>
                        <h3>{chunkId ? '引用来源片段' : '内容片段'}</h3>
                        <p className="muted-text">
                          {chunkId ? '查看该回答实际使用的文档片段。' : `共 ${chunkTotal} 个切片。`}
                        </p>
                      </div>
                      {!chunkId && <form className="chunk-search-form" onSubmit={handleChunkSearch}>
                        <input
                          aria-label="搜索内容片段"
                          placeholder="搜索内容片段"
                          value={chunkQueryDraft}
                          onChange={(event) => setChunkQueryDraft(event.target.value)}
                        />
                        <button className="secondary-button" type="submit" disabled={chunksLoading}>
                          搜索
                        </button>
                      </form>}
                    </header>

                    {chunkError ? (
                      <div className="empty-state" role="alert">{chunkError}</div>
                    ) : chunksLoading ? (
                      <LoadingSkeleton rows={4} columns={1} compact announce />
                    ) : chunks.length === 0 ? (
                      chunkId ? (
                        <div className="empty-state" role="alert">
                          未找到该引用片段，可能已重新处理或删除。你仍可查看当前文档内容。
                        </div>
                      ) : (
                        <div className="empty-state">当前还没有内容片段。文档完成处理后可在这里查看。</div>
                      )
                    ) : (
                      <>
                        <div className="document-chunk-list">
                          {chunks.map((chunk) => (
                            <article
                              aria-label={chunkId && chunk.id === chunkId ? '引用来源片段' : undefined}
                              className={chunkId && chunk.id === chunkId
                                ? 'document-chunk-card is-citation-source'
                                : 'document-chunk-card'}
                              key={chunk.id}
                            >
                              <header>
                                <strong>
                                  #{chunk.chunkIndex}
                                  {chunkId && chunk.id === chunkId && (
                                    <span className="citation-source-badge">引用来源</span>
                                  )}
                                </strong>
                                <span>
                                  {chunk.tokenCount} 词元
                                  {chunk.pageNumber ? ` · p.${chunk.pageNumber}` : ''}
                                </span>
                              </header>
                              <p>{chunk.content}</p>
                              {Object.keys(chunk.metadata ?? {}).length > 0 && (
                                <code>{JSON.stringify(chunk.metadata)}</code>
                              )}
                            </article>
                          ))}
                        </div>
                        {!chunkId && <footer className="drawer-pagination chunk-pagination">
                          <span>第 {chunkPage} / {chunkTotalPages} 页</span>
                          <div className="pager">
                            <button
                              aria-label="上一页"
                              className="secondary-button"
                              type="button"
                              disabled={chunkPage <= 1 || chunksLoading}
                              onClick={() => setChunkPage(chunkPage - 1)}
                            >
                              <ChevronLeft aria-hidden="true" />
                            </button>
                            <button className="secondary-button active-page" type="button">
                              {chunkPage}
                            </button>
                            <button
                              aria-label="下一页"
                              className="secondary-button"
                              type="button"
                              disabled={chunkPage >= chunkTotalPages || chunksLoading}
                              onClick={() => setChunkPage(chunkPage + 1)}
                            >
                              <ChevronRight aria-hidden="true" />
                            </button>
                          </div>
                        </footer>}
                      </>
                    )}
                  </section>
                </div>
              ) : (
                null
              )}
            </>
          )}
        </section>
      </aside>

      {confirmDelete && document && (
        <ConfirmDialog
          title="删除文档"
          description={`确认删除“${document.filename}”？文档会进入回收站。`}
          confirmLabel="删除"
          busy={submitting}
          error={deleteError}
          onCancel={() => { setDeleteError(''); setConfirmDelete(false); }}
          onConfirm={handleDelete}
        />
      )}
    </>,
    window.document.body,
  );
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'DOCUMENT_FILE_NOT_FOUND') {
      return '原始文件不存在，无法下载或预览。';
    }
    if (err.code === 'FILE_TOO_LARGE_FOR_PREVIEW') {
      return '文件过大，无法在线预览，请下载后查看。';
    }
    return getErrorMessage(err, fallback);
  }
  return getErrorMessage(err, fallback);
}
