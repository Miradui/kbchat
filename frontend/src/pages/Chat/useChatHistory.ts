import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ApiError } from '../../api/client';
import { listChatMessages } from '../../api/resources';
import type { ChatMessage, ChatMessageListResponse } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

export const HISTORY_PAGE_SIZE = 50;
type Page = { sessionId?: string; hasMore: boolean; hasNewer: boolean; cursor?: string; newerCursor?: string; revision?: string };
type ReadKind = 'older' | 'newer' | 'around' | 'latest' | 'all';

/** Owns only history reads; writes and their idempotency stay in useChatThread. */
export function useChatHistory(sessionId: string | undefined, setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  onAccessLost: (error: unknown, sessionId: string) => boolean) {
  const [page, setPage] = useState<Page>({ hasMore: false, hasNewer: false });
  const pageRef = useRef(page);
  const activeRef = useRef(sessionId);
  activeRef.current = sessionId;
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const kindRef = useRef<ReadKind | null>(null);
  const lastReadRef = useRef<{ kind: ReadKind; beforePrepend?: () => void; messageId?: string } | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [missingMessageId, setMissingMessageId] = useState('');

  const invalidateHistory = useCallback(() => {
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    kindRef.current = null;
    setLoadingHistory(false);
  }, []);
  const cancelMessageContext = useCallback(() => {
    if (kindRef.current === 'around') invalidateHistory();
  }, [invalidateHistory]);
  const resetHistory = useCallback(() => {
    invalidateHistory();
    lastReadRef.current = null;
    const next = { hasMore: false, hasNewer: false };
    pageRef.current = next;
    setPage(next);
    setHistoryError('');
    setMissingMessageId('');
  }, [invalidateHistory]);
  useEffect(() => { resetHistory(); return invalidateHistory; }, [sessionId, resetHistory, invalidateHistory]);

  const replaceHistory = useCallback((target: string, response: ChatMessageListResponse) => {
    invalidateHistory();
    const next = { sessionId: target, hasMore: Boolean(response.hasMore), hasNewer: Boolean(response.hasNewer),
      cursor: response.nextCursor, newerCursor: response.newerCursor, revision: response.revision };
    pageRef.current = next;
    setPage(next);
    setHistoryError('');
    setMissingMessageId('');
    setMessages(response.items);
  }, [invalidateHistory, setMessages]);

  const readCurrentHistory = useCallback(async (target: string) => {
    const current = pageRef.current;
    if (current.sessionId !== target || current.hasNewer) return listChatMessages(target, { limit: HISTORY_PAGE_SIZE });
    if (!current.cursor) return listChatMessages(target); // Explicit full-history reads stay complete.
    try {
      return await listChatMessages(target, { limit: HISTORY_PAGE_SIZE, since: current.cursor });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CHAT_MESSAGE_CHANGED') {
        return listChatMessages(target, { limit: HISTORY_PAGE_SIZE });
      }
      throw error;
    }
  }, []);

  const updateHistoryRevision = useCallback((target: string, revision: string) => {
    if (pageRef.current.sessionId !== target) return;
    const next = { ...pageRef.current, revision, hasNewer: false, newerCursor: undefined };
    pageRef.current = next;
    setPage(next);
  }, []);

  const loadHistory = useCallback(async (kind: ReadKind, beforePrepend?: () => void, messageId?: string) => {
    const current = pageRef.current;
    const target = activeRef.current;
    if (!target || current.sessionId !== target) return;
    if (kind === 'older' && !current.hasMore || kind === 'newer' && !current.hasNewer) return;
    if (abortRef.current) {
      if (kind !== 'around' && kind !== 'latest') return;
      abortRef.current.abort();
    }
    const epoch = ++epochRef.current;
    lastReadRef.current = { kind, beforePrepend, messageId };
    const controller = new AbortController();
    abortRef.current = controller;
    kindRef.current = kind;
    setLoadingHistory(true);
    setHistoryError('');
    // Keep a missing target while paging so locating it cannot interrupt the read.
    try {
      const response = await listChatMessages(target, kind === 'all' ? undefined : {
        limit: HISTORY_PAGE_SIZE,
        ...(kind === 'older' ? { before: current.cursor, revision: current.revision } : {}),
        ...(kind === 'newer' ? { after: current.newerCursor, revision: current.revision } : {}),
        ...(kind === 'around' ? { around: messageId } : {}),
      }, controller.signal);
      if (epoch !== epochRef.current || activeRef.current !== target) return;
      if (kind === 'all' || kind === 'around' || kind === 'latest') replaceHistory(target, response);
      else {
        beforePrepend?.();
        const next = { ...current, revision: response.revision,
          ...(kind === 'older' ? { hasMore: Boolean(response.hasMore), cursor: response.nextCursor ?? current.cursor }
            : { hasNewer: Boolean(response.hasNewer), newerCursor: response.newerCursor ?? current.newerCursor }),
        };
        pageRef.current = next;
        setPage(next);
        setMessages((items) => {
          const ids = new Set(items.map((item) => item.id));
          const added = response.items.filter((item) => !ids.has(item.id));
          return kind === 'older' ? [...added, ...items] : [...items, ...added];
        });
      }
    } catch (error) {
      if (epoch !== epochRef.current || activeRef.current !== target) return;
      if (kind === 'around' && error instanceof ApiError && error.code === 'CHAT_MESSAGE_NOT_FOUND') {
        setMissingMessageId(messageId ?? '');
        return;
      }
      if (onAccessLost(error, target)) { resetHistory(); return; }
      setHistoryError(error instanceof ApiError && error.code === 'CHAT_MESSAGE_CHANGED'
        ? '会话内容已变化，请重新加载会话。' : getErrorMessage(error, '历史消息加载失败，请重试。'));
    } finally {
      if (epoch === epochRef.current) { abortRef.current = null; kindRef.current = null; setLoadingHistory(false); }
    }
  }, [onAccessLost, replaceHistory, resetHistory, setMessages]);

  const loadOlderMessages = useCallback((beforePrepend?: () => void) => loadHistory('older', beforePrepend), [loadHistory]);
  const loadNewerMessages = useCallback((beforeAppend?: () => void) => loadHistory('newer', beforeAppend), [loadHistory]);
  const loadAllMessages = useCallback(() => loadHistory('all'), [loadHistory]);
  const loadMessageContext = useCallback((messageId: string) => loadHistory('around', undefined, messageId), [loadHistory]);
  const loadLatestMessages = useCallback(() => loadHistory('latest'), [loadHistory]);
  const retryHistory = useCallback(() => {
    const last = lastReadRef.current;
    return last ? loadHistory(last.kind, last.beforePrepend, last.messageId) : Promise.resolve();
  }, [loadHistory]);
  return { hasOlderMessages: page.sessionId === sessionId && page.hasMore, hasNewerMessages: page.sessionId === sessionId && page.hasNewer,
    loadingHistory, historyError, missingMessageId, replaceHistory, resetHistory, invalidateHistory, readCurrentHistory,
    updateHistoryRevision, loadOlderMessages, loadNewerMessages, loadAllMessages, loadMessageContext, cancelMessageContext, loadLatestMessages,
    markMissingMessage: setMissingMessageId, retryHistory };
}
