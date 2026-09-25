import { Archive, ArchiveRestore, Download, Pencil, Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  archiveChatSession,
  deleteChatSession,
  exportChatSession,
  unarchiveChatSession,
  updateChatSessionTitle,
} from '../../api/resources';
import { useToast } from '../../components/feedback/ToastProvider';
import type { OverflowMenuItem } from '../../components/ui/OverflowMenu';
import type { ChatSession } from '../../types/api';
import { downloadBlob } from '../../utils/download';
import { getErrorMessage } from '../../utils/errors';
import type { useChatThread } from './useChatThread';

type Options = {
  sessionId?: string;
  activeSessionIdRef: RefObject<string | undefined>;
  thread: ReturnType<typeof useChatThread>;
  mergeSession: (session: ChatSession) => void;
  removeSession: (id: string) => void;
  reloadSessions: () => Promise<void>;
  skipSessionScopeSyncRef: RefObject<boolean>;
};

export function useSessionActions({
  sessionId,
  activeSessionIdRef,
  thread,
  mergeSession,
  removeSession,
  reloadSessions,
  skipSessionScopeSyncRef,
}: Options) {
  const toast = useToast();
  const navigate = useNavigate();
  const sessionActionOperationRef = useRef<symbol | null>(null);
  const sessionExportOperationRef = useRef<symbol | null>(null);
  const sessionBusyRef = useRef(false);
  const [confirmArchive, setConfirmArchive] = useState<ChatSession | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ChatSession | null>(null);
  const [renameTarget, setRenameTarget] = useState<ChatSession | null>(null);
  const [sessionActionError, setSessionActionError] = useState('');
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionExporting, setSessionExporting] = useState(false);

  useLayoutEffect(() => {
    setConfirmArchive(null);
    setConfirmDelete(null);
    setRenameTarget(null);
    setSessionActionError('');
    setSessionBusy(false);
    setSessionExporting(false);
    sessionBusyRef.current = false;
    sessionActionOperationRef.current = null;
    sessionExportOperationRef.current = null;
    return () => {
      sessionActionOperationRef.current = null;
      sessionExportOperationRef.current = null;
      sessionBusyRef.current = false;
    };
  }, [sessionId]);
  async function runSessionAction(
    action: (isCurrent: () => boolean) => Promise<void>,
    failure: string,
  ) {
    if (sessionBusyRef.current || thread.hasPendingWrite()) return;
    const operation = Symbol('session-action');
    const operationSessionId = sessionId;
    sessionActionOperationRef.current = operation;
    sessionBusyRef.current = true;
    setSessionBusy(true);
    setSessionActionError('');
    const isCurrent = () =>
      sessionActionOperationRef.current === operation &&
      activeSessionIdRef.current === operationSessionId;
    try {
      await action(isCurrent);
    } catch (caught) {
      if (
        sessionActionOperationRef.current === operation &&
        activeSessionIdRef.current === operationSessionId
      ) {
        setSessionActionError(getErrorMessage(caught, failure));
      }
    } finally {
      if (sessionActionOperationRef.current === operation) {
        sessionActionOperationRef.current = null;
        sessionBusyRef.current = false;
        setSessionBusy(false);
      }
    }
  }

  async function handleSessionExport(targetSession: ChatSession) {
    if (sessionExportOperationRef.current || sessionBusyRef.current || thread.hasPendingWrite())
      return;
    const operation = Symbol('chat-session-export');
    sessionExportOperationRef.current = operation;
    setSessionExporting(true);
    setSessionActionError('');
    try {
      const blob = await exportChatSession(targetSession.id);
      if (sessionExportOperationRef.current !== operation) return;
      downloadBlob(blob, chatExportFilename(targetSession.title));
      toast.success('会话已导出');
    } catch (caught) {
      if (sessionExportOperationRef.current === operation) {
        setSessionActionError(getErrorMessage(caught, '会话导出失败'));
      }
    } finally {
      if (sessionExportOperationRef.current === operation) {
        sessionExportOperationRef.current = null;
        setSessionExporting(false);
      }
    }
  }

  function renameSession(target: ChatSession, title: string) {
    void runSessionAction(async (isCurrent) => {
      const updated = await updateChatSessionTitle(target.id, title);
      mergeSession(updated);
      if (!isCurrent()) return;
      if (activeSessionIdRef.current === target.id) thread.setSession(updated);
      setRenameTarget(null);
      toast.success('会话已重命名');
    }, '会话标题更新失败');
  }

  function getSessionActions(target: ChatSession, includeRename = false): OverflowMenuItem[] {
    return [
      ...(includeRename
        ? [
            {
              label: '重命名会话',
              icon: <Pencil aria-hidden="true" />,
              onSelect: () => {
                if (sessionBusyRef.current || thread.hasPendingWrite()) return;
                setSessionActionError('');
                setRenameTarget(target);
              },
            },
          ]
        : []),
      target.archivedAt
        ? {
            label: '取消归档',
            icon: <ArchiveRestore aria-hidden="true" />,
            onSelect: () =>
              void runSessionAction(async (isCurrent) => {
                const restored = await unarchiveChatSession(target.id);
                if (!isCurrent()) return;
                removeSession(target.id);
                if (activeSessionIdRef.current === target.id) {
                  skipSessionScopeSyncRef.current = true;
                  thread.setSession(restored);
                  void reloadSessions();
                }
                // The rail only holds one scope at a time, so refetch instead of
                // guessing which list the session now belongs to.
                toast.success('会话已取消归档');
              }, '取消归档失败'),
          }
        : {
            label: '归档会话',
            icon: <Archive aria-hidden="true" />,
            onSelect: () => {
              if (sessionBusyRef.current || thread.hasPendingWrite()) return;
              setSessionActionError('');
              setConfirmArchive(target);
            },
          },
      {
        label: '导出会话',
        icon: <Download aria-hidden="true" />,
        onSelect: () => void handleSessionExport(target),
      },
      {
        label: '删除会话',
        icon: <Trash2 aria-hidden="true" />,
        tone: 'danger',
        onSelect: () => {
          if (sessionBusyRef.current || thread.hasPendingWrite()) return;
          setSessionActionError('');
          setConfirmDelete(target);
        },
      },
    ];
  }

  function confirmArchiveSession() {
    if (!confirmArchive) return;
    const target = confirmArchive;
    void runSessionAction(async (isCurrent) => {
      const archivedSession = await archiveChatSession(target.id);
      if (!isCurrent()) return;
      removeSession(target.id);
      if (activeSessionIdRef.current === target.id) {
        skipSessionScopeSyncRef.current = true;
        thread.setSession(archivedSession);
      }
      setConfirmArchive(null);
      toast.success('会话已归档');
    }, '会话归档失败');
  }
  function confirmDeleteSession() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    void runSessionAction(async (isCurrent) => {
      await deleteChatSession(target.id);
      if (!isCurrent()) return;
      removeSession(target.id);
      setConfirmDelete(null);
      toast.success('会话已删除');
      if (activeSessionIdRef.current === target.id) navigate('/chat', { replace: true });
    }, '会话删除失败');
  }
  return {
    confirmArchive,
    setConfirmArchive,
    confirmDelete,
    setConfirmDelete,
    renameTarget,
    setRenameTarget,
    sessionActionError,
    setSessionActionError,
    sessionBusy,
    sessionBusyRef,
    sessionExporting,
    renameSession,
    getSessionActions,
    confirmArchiveSession,
    confirmDeleteSession,
  };
}
function chatExportFilename(title: string): string {
  const safeTitle = title
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .slice(0, 80)
    .trim();
  return `${safeTitle || '会话记录'}.md`;
}
