import { useCallback, useEffect, useRef, useState } from 'react';

import { listChatSessions } from '../../api/resources';
import { useKnowledgeBaseOptions } from '../../hooks/useKnowledgeBaseOptions';
import type { ChatSession } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

/**
 * Sessions and knowledge bases for the rail.
 *
 * `GET /chat/sessions` filters, paginates, and enriches server side, so the rail
 * asks for exactly the slice it shows instead of pulling everything and grouping
 * in the browser.
 */
const SESSION_PAGE_SIZE = 50;

function sortSessions(sessions: ChatSession[]) {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

type UseChatSessionsOptions = {
  /** Empty string means every knowledge base. */
  knowledgeBaseId?: string;
  /** Archived sessions live behind their own view. */
  archived?: boolean;
};

export function useChatSessions({
  knowledgeBaseId = '',
  archived = false,
}: UseChatSessionsOptions = {}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const options = useKnowledgeBaseOptions();
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [loadMoreError, setLoadMoreError] = useState('');
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const sessionRequestRef = useRef(0);
  const sessionPageRef = useRef(1);
  const loadingMoreRef = useRef(false);

  const loadSessions = useCallback(async () => {
    const request = ++sessionRequestRef.current;
    sessionPageRef.current = 1;
    loadingMoreRef.current = false;
    setLoadMoreError('');
    setSessionsLoadingMore(false);
    setSessionsLoading(true);
    try {
      const response = await listChatSessions({
        archived,
        knowledgeBaseId: knowledgeBaseId || undefined,
        page: 1,
        pageSize: SESSION_PAGE_SIZE,
      });
      if (sessionRequestRef.current === request) {
        const total = response.total ?? response.items.length;
        setSessions(sortSessions(response.items));
        setSessionTotal(total);
        sessionPageRef.current = response.page ?? 1;
        setSessionsError('');
      }
    } catch (caught) {
      if (sessionRequestRef.current === request) {
        setSessionsError(getErrorMessage(caught, '会话列表加载失败'));
      }
    } finally {
      if (sessionRequestRef.current === request) setSessionsLoading(false);
    }
  }, [archived, knowledgeBaseId]);

  const loadMoreSessions = useCallback(async () => {
    if (loadingMoreRef.current || sessionsLoading || sessions.length >= sessionTotal) return;
    const request = ++sessionRequestRef.current;
    const page = sessionPageRef.current + 1;
    loadingMoreRef.current = true;
    setSessionsLoadingMore(true);
    setLoadMoreError('');
    try {
      const response = await listChatSessions({
        archived,
        knowledgeBaseId: knowledgeBaseId || undefined,
        page,
        pageSize: SESSION_PAGE_SIZE,
      });
      if (sessionRequestRef.current === request) {
        setSessions((current) => {
          const byId = new Map(current.map((session) => [session.id, session]));
          response.items.forEach((session) => byId.set(session.id, session));
          return sortSessions([...byId.values()]);
        });
        setSessionTotal(response.total ?? Math.max(sessionTotal, sessions.length + response.items.length));
        sessionPageRef.current = response.page ?? page;
      }
    } catch (caught) {
      if (sessionRequestRef.current === request) {
        setLoadMoreError(getErrorMessage(caught, '更多会话加载失败'));
      }
    } finally {
      loadingMoreRef.current = false;
      if (sessionRequestRef.current === request) setSessionsLoadingMore(false);
    }
  }, [archived, knowledgeBaseId, sessionTotal, sessions, sessionsLoading]);


  useEffect(() => {
    void loadSessions();
    return () => {
      sessionRequestRef.current += 1;
    };
  }, [loadSessions]);


  const mergeSession = useCallback((session: ChatSession) => {
    // A response that started before this local mutation must not overwrite it.
    sessionRequestRef.current += 1;
    setSessionsLoading(false);
    setSessions((current) => {
      const index = current.findIndex((item) => item.id === session.id);
      if (index === -1) {
        setSessionTotal((total) => total + 1);
        return sortSessions([session, ...current]);
      }
      // Single-session responses omit the list-only fields, so keep whatever the
      // list already knows rather than blanking the row.
      const next = [...current];
      next[index] = { ...current[index], ...session };
      return sortSessions(next);
    });
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    // Archive/delete commits locally; invalidate an older list response first.
    sessionRequestRef.current += 1;
    setSessionsLoading(false);
    setSessions((current) => {
      if (!current.some((item) => item.id === sessionId)) return current;
      setSessionTotal((total) => Math.max(0, total - 1));
      return current.filter((item) => item.id !== sessionId);
    });
  }, []);

  return {
    sessions,
    sessionTotal,
    hasMoreSessions: sessionTotal > sessions.length,
    sessionsLoadingMore,
    loadMoreError,
    knowledgeBases: options.items,
    sessionsLoading,
    knowledgeBasesLoading: options.loading,
    sessionsError,
    knowledgeBasesError: options.error,
    reloadSessions: loadSessions,
    loadMoreSessions,
    reloadKnowledgeBases: options.reload,
    mergeSession,
    removeSession,
  };
}
