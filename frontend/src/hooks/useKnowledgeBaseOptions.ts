import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listKnowledgeBases } from '../api/resources';
import { ApiError } from '../api/client';
import type { KnowledgeBase } from '../types/api';
import { tokenStore } from '../store/tokenStore';
import { knowledgeBaseOptionsKey, queryClient } from '../store/queryClient';
import { getErrorMessage } from '../utils/errors';

const parameters = { page: 1, pageSize: 100, sort: 'updatedAt_desc' } as const;
const empty: KnowledgeBase[] = [];
const sourceIds = new WeakMap<() => Promise<KnowledgeBase[]>, number>();
let sourceSequence = 0;
export const loadKnowledgeBaseOptions = async (signal?: AbortSignal) =>
  (await listKnowledgeBases(parameters, signal)).items;

export function useKnowledgeBaseOptions(load = loadKnowledgeBaseOptions) {
  const revision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision);
  if (!sourceIds.has(load)) sourceIds.set(load, ++sourceSequence);
  const queryKey = [...knowledgeBaseOptionsKey, revision, parameters, sourceIds.get(load)];
  const query = useQuery(
    {
      queryKey,
      queryFn: async ({ signal }) => {
        try {
          const items = await load(signal);
          if (tokenStore.getRevision() !== revision) throw new Error('账户已切换');
          return items;
        } catch (error) {
          if (
            tokenStore.getRevision() === revision &&
            error instanceof ApiError &&
            (error.status === 401 || error.status === 403)
          ) {
            // Keep the denied refresh visible as an error, but discard old options.
            queryClient.setQueryData(queryKey, empty);
          }
          throw error;
        }
      },
    },
    queryClient,
  );
  return {
    items:
      query.error instanceof ApiError && (query.error.status === 401 || query.error.status === 403)
        ? empty
        : (query.data ?? empty),
    loading: query.isPending,
    error: query.error ? getErrorMessage(query.error, '知识库列表加载失败') : '',
    reload: query.refetch,
  };
}
