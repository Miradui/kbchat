import { useCallback, useEffect, useRef, useState } from 'react';

import {
  batchRestoreKnowledgeBases,
  deleteKnowledgeBasePermanently,
  emptyKnowledgeBaseRecycleBin,
  listKnowledgeBaseRecycleBin,
  restoreKnowledgeBase,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/feedback/EmptyState';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { useEntityMutation } from '../../hooks/useEntityMutation';
import type { RecycleBinItem } from '../../types/api';
import { formatDateTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';

type RecycleBinDrawerProps = {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
};

export function KnowledgeBaseRecycleBinDrawer({ open, onClose, onChanged }: RecycleBinDrawerProps) {
  const toast = useToast();
  const mutation = useEntityMutation();
  const [items, setItems] = useState<RecycleBinItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [permanentTarget, setPermanentTarget] = useState<RecycleBinItem | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const response = await listKnowledgeBaseRecycleBin(1, 50);
      if (requestRef.current === request) setItems(response.items);
    } catch (caught) {
      if (requestRef.current === request) setError(getErrorMessage(caught, '回收站加载失败'));
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  async function withFeedback(key: string, action: () => Promise<void>, success: string, failure: string) {
    await mutation.run(key, async () => {
      try {
        await action();
        toast.success(success);
        await load();
        onChanged();
      } catch (caught) {
        toast.error(getErrorMessage(caught, failure));
      }
    });
  }

  return (
    <>
      <Drawer
        headerActions={
          <>
            <Button
              disabled={loading || items.length === 0}
              variant="secondary"
              onClick={() => void withFeedback(
                'restore-all',
                async () => { await batchRestoreKnowledgeBases(items.map((item) => item.id)); },
                '知识库已全部恢复',
                '批量恢复失败',
              )}
            >
              恢复全部
            </Button>
            <Button
              disabled={loading || items.length === 0}
              variant="secondary"
              onClick={() => {
                setDialogError('');
                setConfirmEmpty(true);
              }}
            >
              清空
            </Button>
          </>
        }
        onClose={onClose}
        open={open}
        title="知识库回收站"
      >
        {loading && items.length === 0 ? (
          <LoadingSkeleton announce compact columns={1} rows={4} />
        ) : error ? (
          <div className="ui-inline-error" role="alert">
            <span>{error}</span>
            <Button variant="link" onClick={() => void load()}>重试</Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="回收站为空" description="删除的知识库会先移到这里，可随时恢复。" />
        ) : (
          <div className="recycle-list">
            {items.map((item) => (
              <article className="recycle-list__item" key={item.id}>
                <div className="ui-cell-stack">
                  <strong>{item.name}</strong>
                  <small>删除于 {formatDateTime(item.deletedAt)}</small>
                </div>
                <div className="recycle-list__actions">
                  <Button
                    disabled={mutation.isPending(item.id)}
                    loading={mutation.isPending(item.id)}
                    loadingLabel="恢复中"
                    variant="secondary"
                    onClick={() => void withFeedback(
                      item.id,
                      () => restoreKnowledgeBase(item.id),
                      '知识库恢复成功',
                      '知识库恢复失败',
                    )}
                  >
                    恢复
                  </Button>
                  <Button
                    disabled={mutation.isPending(item.id)}
                    variant="ghost"
                    onClick={() => {
                      setDialogError('');
                      setPermanentTarget(item);
                    }}
                  >
                    永久删除
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Drawer>

      {permanentTarget && (
        <ConfirmDialog
          busy={mutation.isPending(`permanent-${permanentTarget.id}`)}
          confirmLabel="永久删除"
          description={`确认永久删除“${permanentTarget.name}”？关联文档、内容片段、会话和成员数据会被清理，且不可恢复。`}
          error={dialogError}
          onCancel={() => {
            setDialogError('');
            setPermanentTarget(null);
          }}
          onConfirm={() => {
            const target = permanentTarget;
            void mutation.run(`permanent-${target.id}`, async () => {
              try {
                await deleteKnowledgeBasePermanently(target.id);
                setPermanentTarget(null);
                toast.success('知识库已永久删除');
                await load();
                onChanged();
              } catch (caught) {
                setDialogError(getErrorMessage(caught, '永久删除失败'));
              }
            });
          }}
          title="永久删除知识库"
        />
      )}

      {confirmEmpty && (
        <ConfirmDialog
          busy={mutation.isPending('empty')}
          confirmLabel="清空"
          description="确认清空知识库回收站？操作失败时不会删除其中任何知识库。"
          error={dialogError}
          onCancel={() => {
            setDialogError('');
            setConfirmEmpty(false);
          }}
          onConfirm={() => {
            void mutation.run('empty', async () => {
              try {
                await emptyKnowledgeBaseRecycleBin();
                setConfirmEmpty(false);
                toast.success('回收站已清空');
                await load();
                onChanged();
              } catch (caught) {
                setDialogError(getErrorMessage(caught, '清空失败，未删除任何知识库。'));
              }
            });
          }}
          title="清空回收站"
        />
      )}
    </>
  );
}
