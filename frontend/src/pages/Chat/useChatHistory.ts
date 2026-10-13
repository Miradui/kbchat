import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ApiError } from '../../api/client';
import { listChatMessages } from '../../api/resources';
import type { ChatMessage, ChatMessageListResponse } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

export const HISTORY_PAGE_SIZE = 50;
type Page = { sessionId?: string; hasMore: boolean; cursor?: string; revision?: string };

/** Owns only history reads; writes and their idempotency stay in useChatThread. */
export function useChatHistory(sessionId: string | undefined, setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  onAccessLost: (error: unknown, sessionId: string) => boolean) {
  const [page, setPage] = useState<Page>({ hasMore: false });
  const pageRef = useRef(page);
  const activeRef = useRef(sessionId);
  activeRef.current = sessionId;
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');

  const invalidateHistory = useCallback(() => {
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoadingHistory(false);
  }, []);
  const resetHistory = useCallback(() => {
    invalidateHistory();
    const next = { hasMore: false };
    pageRef.current = next;
    setPage(next);
    setHistoryError('');
  }, [invalidateHistory]);
  useEffect(() => { resetHistory(); return invalidateHistory; }, [sessionId, resetHistory, invalidateHistory]);

  const replaceHistory = useCallback((target: string, response: ChatMessageListResponse) => {
    invalidateHistory();
    const next = { sessionId: target, hasMore: Boolean(response.hasMore), cursor: response.nextCursor, revision: response.revision };
    pageRef.current = next;
    setPage(next);
    setHistoryError('');
    setMessages(response.items);
  }, [invalidateHistory, setMessages]);

  const readCurrentHistory = useCallback(async (target: string) => {
    const current = pageRef.current;
    if (current.sessionId !== target) return listChatMessages(target, { limit: HISTORY_PAGE_SIZE });
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
    const next = { ...pageRef.current, revision };
    pageRef.current = next;
    setPage(next);
  }, []);

  const loadHistory = useCallback(async (all: boolean, beforePrepend?: () => void) => {
    const current = pageRef.current;
    const target = activeRef.current;
    if (!target || current.sessionId !== target || !current.hasMore || abortRef.current) return;
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadingHistory(true);
    setHistoryError('');
    try {
      const response = await listChatMessages(target, all ? undefined : {
        limit: HISTORY_PAGE_SIZE, before: current.cursor, revision: current.revision,
      }, controller.signal);
      if (epoch !== epochRef.current || activeRef.current !== target) return;
      if (all) replaceHistory(target, response);
      else {
        beforePrepend?.();
        const next = { sessionId: target, hasMore: Boolean(response.hasMore), cursor: response.nextCursor, revision: response.revision };
        pageRef.current = next;
        setPage(next);
        setMessages((items) => {
          const ids = new Set(items.map((item) => item.id));
          return [...response.items.filter((item) => !ids.has(item.id)), ...items];
        });
      }
    } catch (error) {
      if (epoch !== epochRef.current || activeRef.current !== target) return;
      if (onAccessLost(error, target)) { resetHistory(); return; }
      setHistoryError(error instanceof ApiError && error.code === 'CHAT_MESSAGE_CHANGED'
        ? '会话内容已变化，请重新加载会话。' : getErrorMessage(error, '历史消息加载失败，请重试。'));
    } finally {
      if (epoch === epochRef.current) { abortRef.current = null; setLoadingHistory(false); }
    }
  }, [onAccessLost, replaceHistory, resetHistory, setMessages]);

  const loadOlderMessages = useCallback((beforePrepend?: () => void) => loadHistory(false, beforePrepend), [loadHistory]);
  const loadAllMessages = useCallback(() => loadHistory(true), [loadHistory]);
  return { hasOlderMessages: page.sessionId === sessionId && page.hasMore, loadingHistory, historyError,
    replaceHistory, resetHistory, invalidateHistory, readCurrentHistory, updateHistoryRevision, loadOlderMessages, loadAllMessages };
}
