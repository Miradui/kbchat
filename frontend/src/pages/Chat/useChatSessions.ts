import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';

import { listChatSessions } from '../../api/resources';
import { useKnowledgeBaseOptions } from '../../hooks/useKnowledgeBaseOptions';
import { queryClient } from '../../store/queryClient';
import { tokenStore } from '../../store/tokenStore';
import type { ChatSession, ChatSessionListResponse } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

const SESSION_PAGE_SIZE = 50;
const sessionsKey = ['chat-sessions'] as const;
type SessionPages = InfiniteData<ChatSessionListResponse, number>;

function sortSessions(sessions: ChatSession[]) {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

type UseChatSessionsOptions = {
  /** Empty string means every knowledge base. */
  knowledgeBaseId?: string;
  archived?: boolean;
};

/** Shared, identity-scoped history keeps the rail populated across page changes. */
export function useChatSessions({ knowledgeBaseId = '', archived = false }: UseChatSessionsOptions = {}) {
  const revision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision);
  const queryKey = useMemo(() => [...sessionsKey, revision, knowledgeBaseId, archived] as const,
    [revision, knowledgeBaseId, archived]);
  const options = useKnowledgeBaseOptions();
  const query = useInfiniteQuery<ChatSessionListResponse, Error, SessionPages, typeof queryKey, number>({
    queryKey,
    initialPageParam: 1,
    retry: false,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === revision ? previous : undefined,
    queryFn: async ({ pageParam }) => {
      const response = await listChatSessions({
        archived, knowledgeBaseId: knowledgeBaseId || undefined,
        page: pageParam, pageSize: SESSION_PAGE_SIZE,
      });
      if (revision !== tokenStore.getRevision()) throw new Error('账户已切换');
      return response;
    },
    getNextPageParam: (lastPage, pages, lastPageParam) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0);
      return lastPage.items.length && loaded < (lastPage.total ?? loaded)
        ? (lastPage.page ?? lastPageParam) + 1 : undefined;
    },
  }, queryClient);

  const sessions = useMemo(() => {
    const byId = new Map<string, ChatSession>();
    query.data?.pages.forEach((page) => page.items.forEach((session) => byId.set(session.id, session)));
    return sortSessions([...byId.values()]);
  }, [query.data]);
  const lastPage = query.data?.pages.at(-1);
  const sessionTotal = lastPage?.total ?? sessions.length;

  const updateCachedSessions = useCallback((sessionId: string, updated?: ChatSession) => {
    if (revision !== tokenStore.getRevision()) return;
    const prefix = [...sessionsKey, revision];
    // Cancel before committing: an older list response must not undo a rename,
    // archive, deletion, or access-loss cleanup in any cached scope.
    void queryClient.cancelQueries({ queryKey: prefix });
    const cached = queryClient.getQueriesData<SessionPages>({ queryKey: prefix });
    for (const [key, data] of cached) {
      const filteredKnowledgeBaseId = key[2] as string;
      const filteredArchived = key[3] as boolean;
      const belongs = updated && Boolean(updated.archivedAt) === filteredArchived && (
        !filteredKnowledgeBaseId || (updated.knowledgeBaseIds ?? [updated.knowledgeBaseId]).includes(filteredKnowledgeBaseId)
      );
      if (!data && updated && (!belongs || filteredKnowledgeBaseId !== knowledgeBaseId || filteredArchived !== archived)) continue;
      const pages = data?.pages ?? [{ items: [], total: 0, page: 1, pageSize: SESSION_PAGE_SIZE }];
      const existing = pages.flatMap((page) => page.items).find((session) => session.id === sessionId);
      if (data && !existing && !belongs) continue;
      const delta = belongs ? (existing ? 0 : 1) : existing ? -1 : 0;
      queryClient.setQueryData<SessionPages>(key, {
        pageParams: data?.pageParams ?? [1],
        pages: pages.map((page, index) => ({
          ...page,
          total: Math.max(0, (page.total ?? page.items.length) + delta),
          items: [
            ...(!existing && belongs && index === 0 ? [updated] : []),
            ...page.items.flatMap((session) => session.id !== sessionId ? [session]
              : belongs ? [{ ...session, ...updated }] : []),
          ],
        })),
      });
    }
    // Archive/unarchive can move an item into a scope whose pages are incomplete.
    // Revalidate on the next visit while keeping the current rows visible.
    void queryClient.invalidateQueries({ queryKey: prefix, refetchType: 'none' });
  }, [archived, knowledgeBaseId, revision]);

  const mergeSession = useCallback((session: ChatSession) => updateCachedSessions(session.id, session), [updateCachedSessions]);
  const removeSession = useCallback((id: string) => updateCachedSessions(id), [updateCachedSessions]);
  const { refetch, fetchNextPage } = query;
  const reloadSessions = useCallback(async () => { await refetch(); }, [refetch]);
  const loadMoreSessions = useCallback(async () => {
    if (query.isFetching || !query.hasNextPage) return;
    await fetchNextPage();
  }, [fetchNextPage, query.hasNextPage, query.isFetching]);

  return {
    sessions,
    sessionTotal,
    hasMoreSessions: Boolean(query.hasNextPage),
    sessionsLoadingMore: query.isFetchingNextPage,
    loadMoreError: query.isFetchNextPageError ? getErrorMessage(query.error, '更多会话加载失败') : '',
    knowledgeBases: options.items,
    sessionsLoading: query.isPending || query.isPlaceholderData,
    knowledgeBasesLoading: options.loading,
    sessionsError: query.isError && !query.isFetchNextPageError ? getErrorMessage(query.error, '会话列表加载失败') : '',
    knowledgeBasesError: options.error,
    reloadSessions,
    loadMoreSessions,
    reloadKnowledgeBases: options.reload,
    mergeSession,
    removeSession,
  };
}
