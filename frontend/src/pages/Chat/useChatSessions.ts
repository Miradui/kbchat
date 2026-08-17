import { useCallback, useEffect, useRef, useState } from 'react';

import { listChatSessions, listKnowledgeBases } from '../../api/resources';
import type { ChatSession, KnowledgeBase } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

/**
 * Sessions and knowledge bases for the rail.
 *
 * `GET /chat/sessions` filters, paginates, and enriches server side, so the rail
 * asks for exactly the slice it shows instead of pulling everything and grouping
 * in the browser.
 */
const SESSION_PAGE_SIZE = 50;

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
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [knowledgeBasesLoading, setKnowledgeBasesLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [knowledgeBasesError, setKnowledgeBasesError] = useState('');
  const sessionRequestRef = useRef(0);
  const kbRequestRef = useRef(0);

  const loadSessions = useCallback(async () => {
    const request = ++sessionRequestRef.current;
    setSessionsLoading(true);
    try {
      const response = await listChatSessions({
        archived,
        knowledgeBaseId: knowledgeBaseId || undefined,
        page: 1,
        pageSize: SESSION_PAGE_SIZE,
      });
      if (sessionRequestRef.current === request) {
        setSessions(response.items);
        setSessionTotal(response.total);
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

  const loadKnowledgeBases = useCallback(async () => {
    const request = ++kbRequestRef.current;
    setKnowledgeBasesLoading(true);
    try {
      const response = await listKnowledgeBases({ pageSize: 100 });
      if (kbRequestRef.current === request) {
        setKnowledgeBases(response.items);
        setKnowledgeBasesError('');
      }
    } catch (caught) {
      if (kbRequestRef.current === request) {
        setKnowledgeBasesError(getErrorMessage(caught, '知识库列表加载失败'));
      }
    } finally {
      if (kbRequestRef.current === request) setKnowledgeBasesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    return () => {
      sessionRequestRef.current += 1;
    };
  }, [loadSessions]);

  useEffect(() => {
    void loadKnowledgeBases();
    return () => {
      kbRequestRef.current += 1;
    };
  }, [loadKnowledgeBases]);

  const mergeSession = useCallback((session: ChatSession) => {
    // A response that started before this local mutation must not overwrite it.
    sessionRequestRef.current += 1;
    setSessionsLoading(false);
    setSessions((current) => {
      const index = current.findIndex((item) => item.id === session.id);
      if (index === -1) {
        setSessionTotal((total) => total + 1);
        return [session, ...current];
      }
      // Single-session responses omit the list-only fields, so keep whatever the
      // list already knows rather than blanking the row.
      const next = [...current];
      next[index] = { ...current[index], ...session };
      return next;
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
    knowledgeBases,
    sessionsLoading,
    knowledgeBasesLoading,
    sessionsError,
    knowledgeBasesError,
    reloadSessions: loadSessions,
    reloadKnowledgeBases: loadKnowledgeBases,
    mergeSession,
    removeSession,
  };
}
