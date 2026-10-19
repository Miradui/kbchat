import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ChatSessionRenameDialog } from './ChatSessionRenameDialog';
import type { useSessionActions } from './useSessionActions';

export function ChatSessionActionDialogs({ actions }: { actions: ReturnType<typeof useSessionActions> }) {
  const {
    renameTarget, setRenameTarget, renameSession, confirmArchive, setConfirmArchive,
    confirmDelete, setConfirmDelete, sessionBusy, sessionBusyRef, sessionActionError,
    setSessionActionError, confirmArchiveSession, confirmDeleteSession,
  } = actions;
  return <>
    {renameTarget && <ChatSessionRenameDialog key={renameTarget.id} title={renameTarget.title || ''}
      busy={sessionBusy} error={sessionActionError}
      onClose={() => { if (!sessionBusyRef.current) { setRenameTarget(null); setSessionActionError(''); } }}
      onSubmit={(title) => renameSession(renameTarget, title)} />}
    {confirmArchive && <ConfirmDialog
      busy={sessionBusy}
      confirmLabel="归档"
      description={`归档后“${confirmArchive.title || '未命名会话'}”将移至“已归档”列表，可随时取消归档继续对话。`}
      error={sessionActionError}
      onCancel={() => { setSessionActionError(''); setConfirmArchive(null); }}
      onConfirm={confirmArchiveSession}
      title="归档会话"
    />}
    {confirmDelete && <ConfirmDialog
      busy={sessionBusy}
      confirmLabel="删除"
      description={`确认删除“${confirmDelete.title || '未命名会话'}”？会话和消息将移入回收站，可在永久删除前恢复。`}
      error={sessionActionError}
      onCancel={() => { setSessionActionError(''); setConfirmDelete(null); }}
      onConfirm={confirmDeleteSession}
      title="删除会话"
    />}
  </>;
}
