import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

import { ApiError } from '../../api/client';
import {
  batchRestoreDocuments,
  deleteDocumentPermanently,
  emptyDocumentRecycleBin,
  listDocumentRecycleBin,
  restoreDocument,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { useToast } from '../../components/feedback/ToastProvider';
import { IconButton } from '../../components/ui/IconButton';
import { useModalFocus } from '../../components/ui/useModalFocus';
import type { RecycleBinItem } from '../../types/api';
import { formatDocumentDateTime } from './documentDisplay';

type DocumentRecycleBinDrawerProps = {
  onChanged: () => void;
  onClose: () => void;
};

export function DocumentRecycleBinDrawer({
  onChanged,
  onClose,
}: DocumentRecycleBinDrawerProps) {
  const toast = useToast();
  const loadRequestRef = useRef(0);
  const mutationOperationRef = useRef<symbol | null>(null);
  const explicitRefreshInFlightRef = useRef(false);
  const mountedRef = useRef(false);
  const requestClose = useCallback(() => {
    if (!mutationOperationRef.current) {
      onClose();
    }
  }, [onClose]);
  const panelRef = useModalFocus<HTMLElement>(true, requestClose);
  const [items, setItems] = useState<RecycleBinItem[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RecycleBinItem | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [error, setError] = useState('');
  const mutationBusy = workingId !== null || submitting;

  const loadPage = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const response = await listDocumentRecycleBin(page, pageSize);
      if (loadRequestRef.current === request) {
        setItems(response.items);
        setTotal(response.total);
      }
    } catch (err) {
      if (loadRequestRef.current === request) {
        setError(errorMessage(err, '文档回收站加载失败'));
      }
    } finally {
      if (loadRequestRef.current === request) {
        setLoading(false);
      }
    }
  }, [page, pageSize]);

  const refreshPage = useCallback(async (fallback: string) => {
    if (explicitRefreshInFlightRef.current) {
      return;
    }
    explicitRefreshInFlightRef.current = true;
    setRefreshing(true);
    setError('');
    try {
      await loadPage();
    } catch (err) {
      if (mountedRef.current) {
        setError(errorMessage(err, fallback));
      }
    } finally {
      explicitRefreshInFlightRef.current = false;
      if (mountedRef.current) {
        setRefreshing(false);
      }
    }
  }, [loadPage]);

  const refreshAfterMutation = useCallback(async () => {
    if (!mountedRef.current) {
      return;
    }
    onChanged();
    if (!mountedRef.current) {
      return;
    }
    await loadPage();
  }, [loadPage, onChanged]);

  useEffect(() => {
    void loadPage();

    return () => {
      loadRequestRef.current += 1;
      mutationOperationRef.current = null;
    };
  }, [loadPage]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleRestore(item: RecycleBinItem) {
    if (mutationOperationRef.current) {
      return;
    }
    const operation = Symbol('restore-document');
    mutationOperationRef.current = operation;
    setWorkingId(item.id);
    setError('');

    try {
      await restoreDocument(item.id);
      if (mutationOperationRef.current !== operation) {
        return;
      }
      toast.success('文档恢复成功');
      await refreshAfterMutation();
    } catch (err) {
      if (mutationOperationRef.current === operation) {
        setError(errorMessage(err, '文档恢复失败'));
      }
    } finally {
      if (mutationOperationRef.current === operation) {
        mutationOperationRef.current = null;
        setWorkingId(null);
      }
    }
  }

  async function handleRestorePage() {
    if (items.length === 0 || mutationOperationRef.current) {
      return;
    }

    const operation = Symbol('restore-document-page');
    mutationOperationRef.current = operation;
    setSubmitting(true);
    setError('');

    try {
      await batchRestoreDocuments(items.map((item) => item.id));
      if (mutationOperationRef.current !== operation) {
        return;
      }
      toast.success('本页文档恢复成功');
      await refreshAfterMutation();
    } catch (err) {
      if (mutationOperationRef.current === operation) {
        setError(errorMessage(err, '批量恢复失败'));
      }
    } finally {
      if (mutationOperationRef.current === operation) {
        mutationOperationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  async function handlePermanentDelete() {
    if (!deleteTarget || mutationOperationRef.current) {
      return;
    }

    const operation = Symbol('permanently-delete-document');
    mutationOperationRef.current = operation;
    setSubmitting(true);
    setConfirmError('');

    try {
      await deleteDocumentPermanently(deleteTarget.id);
      if (mutationOperationRef.current !== operation) {
        return;
      }
      setDeleteTarget(null);
      toast.success('文档已永久删除');
      await refreshAfterMutation();
    } catch (err) {
      if (mutationOperationRef.current === operation) {
        setConfirmError(errorMessage(err, '文档永久删除失败'));
      }
    } finally {
      if (mutationOperationRef.current === operation) {
        mutationOperationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  async function handleEmptyRecycleBin() {
    if (mutationOperationRef.current) {
      return;
    }
    const operation = Symbol('empty-document-recycle-bin');
    mutationOperationRef.current = operation;
    setSubmitting(true);
    setConfirmError('');

    try {
      await emptyDocumentRecycleBin();
      if (mutationOperationRef.current !== operation) {
        return;
      }
      setConfirmEmpty(false);
      toast.success('文档回收站已清空');
      await refreshAfterMutation();
    } catch (err) {
      if (mutationOperationRef.current === operation) {
        setConfirmError(errorMessage(err, '清空失败，未删除任何文档。'));
      }
    } finally {
      if (mutationOperationRef.current === operation) {
        mutationOperationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return createPortal(
    <>
    <aside className="drawer-backdrop" role="presentation">
      <section
        aria-labelledby="document-recycle-title"
        aria-modal="true"
        className="drawer-panel document-recycle-drawer"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="document-recycle-title">文档回收站</h2>
            <p className="muted-text">展示当前用户已删除的文档，可恢复到原知识库。</p>
          </div>
          <IconButton label="关闭" onClick={requestClose} disabled={mutationBusy}><X aria-hidden="true" /></IconButton>
        </header>

        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={() => void loadPage()} disabled={loading || mutationBusy}>
            刷新
          </button>
          <button className="secondary-button" type="button" onClick={() => void handleRestorePage()} disabled={mutationBusy || items.length === 0}>
            {submitting ? '恢复中...' : '恢复本页'}
          </button>
          <button className="danger-button" type="button" onClick={() => { setConfirmError(''); setConfirmEmpty(true); }} disabled={mutationBusy || items.length === 0}>
            清空回收站
          </button>
        </div>

        <div className="recycle-list document-recycle-list">
          {loading ? (
            <LoadingSkeleton rows={5} columns={2} compact announce />
          ) : error ? (
            <div className="empty-state" role="alert">
              <p>{error}</p>
              <button className="secondary-button" type="button" onClick={() => void loadPage()}>
                重试加载
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">文档回收站为空。</div>
          ) : (
            items.map((item) => (
              <article className="recycle-item document-recycle-item" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.knowledgeBaseName || '未知知识库'}</span>
                  <span>删除时间 {formatDocumentDateTime(item.deletedAt)}</span>
                </div>
                <div className="table-actions">
                  <button
                    aria-label={workingId === item.id ? `正在恢复 ${item.name}` : `恢复 ${item.name}`}
                    className="secondary-button"
                    type="button"
                    onClick={() => void handleRestore(item)}
                    disabled={mutationBusy}
                  >
                    {workingId === item.id ? '恢复中...' : '恢复'}
                  </button>
                  <button
                    aria-label={`永久删除 ${item.name}`}
                    className="danger-button"
                    type="button"
                    onClick={() => { setConfirmError(''); setDeleteTarget(item); }}
                    disabled={mutationBusy}
                  >
                    永久删除
                  </button>
                </div>
              </article>
            ))
          )}
        </div>

        <footer className="drawer-pagination">
          <span>共 {error ? '--' : total} 条</span>
          <div className="pager">
            <button aria-label="上一页" className="secondary-button" type="button" disabled={page <= 1 || mutationBusy} onClick={() => setPage(page - 1)}>
              <ChevronLeft aria-hidden="true" />
            </button>
            <button className="secondary-button active-page" type="button">
              {page}
            </button>
            <button aria-label="下一页" className="secondary-button" type="button" disabled={page >= totalPages || mutationBusy} onClick={() => setPage(page + 1)}>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
        </footer>
      </section>
    </aside>
    {deleteTarget && (
      <ConfirmDialog
        title="永久删除文档"
        description={`确认永久删除“${deleteTarget.name}”？该操作不可恢复。`}
        confirmLabel="永久删除"
        busy={submitting}
        error={confirmError}
        onCancel={() => { setConfirmError(''); setDeleteTarget(null); }}
        onConfirm={handlePermanentDelete}
      />
    )}
    {confirmEmpty && (
      <ConfirmDialog
        title="清空文档回收站"
        description="确认清空文档回收站？操作失败时不会删除其中任何文档。"
        confirmLabel="清空"
        busy={submitting}
        error={confirmError}
        onCancel={() => { setConfirmError(''); setConfirmEmpty(false); }}
        onConfirm={handleEmptyRecycleBin}
      />
    )}
    </>,
    document.body,
  );
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  return fallback;
}
