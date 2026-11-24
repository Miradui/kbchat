import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { SetStateAction } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';

import { getKnowledgeBase, recordKnowledgeBaseView } from '../../api/resources';
import { knowledgeBaseDetailKey, queryClient } from '../../store/queryClient';
import { tokenStore } from '../../store/tokenStore';
import type { KnowledgeBase } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

/**
 * Loads one knowledge base and ignores responses for a base the user has already
 * navigated away from.
 */
export function useKnowledgeBase() {
  const { id } = useParams();
  const revision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision);
  const queryKey = useMemo(() => [...knowledgeBaseDetailKey, revision, id ?? ''] as const, [revision, id]);
  const viewedRef = useRef<{ revision: number; id: string } | null>(null);

  const query = useQuery({
    queryKey,
    enabled: Boolean(id),
    retry: false,
    queryFn: async () => {
      if (!id) throw new Error('缺少知识库标识');
      const response = await getKnowledgeBase(id);
      if (tokenStore.getRevision() !== revision) throw new Error('账户已切换');
      return response;
    },
  }, queryClient);

  const knowledgeBase = query.data ?? null;
  const loadedId = knowledgeBase?.id;

  useEffect(() => {
    if (!id || loadedId !== id) return;
    if (viewedRef.current?.revision === revision && viewedRef.current?.id === id) return;
    viewedRef.current = { revision, id };
    // Views are recorded explicitly by the API contract, never implicitly on GET.
    void recordKnowledgeBaseView(id).catch(() => undefined);
  }, [id, loadedId, revision]);

  const setKnowledgeBase = useCallback((next: SetStateAction<KnowledgeBase | null>) => {
    if (!id || tokenStore.getRevision() !== revision) return;
    queryClient.setQueryData<KnowledgeBase | null>(queryKey, (current) => (
      typeof next === 'function' ? next(current ?? null) : next
    ));
  }, [id, queryKey, revision]);

  const { refetch } = query;
  const reload = useCallback(async () => {
    if (!id) return;
    await refetch();
  }, [id, refetch]);

  return {
    id,
    knowledgeBase,
    setKnowledgeBase,
    loading: query.isPending || (query.isFetching && !knowledgeBase),
    error: !query.isFetching && query.isError ? getErrorMessage(query.error, '知识库详情加载失败') : '',
    reload,
  };
}
