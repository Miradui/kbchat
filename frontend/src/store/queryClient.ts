import { QueryClient } from '@tanstack/react-query';
import { tokenStore } from './tokenStore';

export const knowledgeBaseOptionsKey = ['knowledge-base-options'] as const;
export const knowledgeBaseListKey = ['knowledge-base-list'] as const;
export const knowledgeBaseDetailKey = ['knowledge-base-detail'] as const;
export const homeSummaryKey = ['home-summary'] as const;
export const homeActivitiesKey = ['home-activities'] as const;
export const documentListKey = ['document-list'] as const;
export const documentCountsKey = ['document-counts'] as const;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 300_000,
      refetchOnWindowFocus: false,
      retryDelay: 250,
      retry: (failures, error) => {
        const status = 'status' in error ? Number(error.status) : 0;
        return failures < 1 && (status === 0 || status >= 500);
      },
    },
    mutations: { retry: false },
  },
});

// Navigation position is local UI state, so retain it until the account cache is
// cleared instead of expiring it while the user reads a long conversation.
queryClient.setQueryDefaults(['chat-rail-preferences'], { gcTime: Infinity });
queryClient.setQueryDefaults(['chat-rail-scroll'], { gcTime: Infinity });

// Clear synchronously: a late request from a prior identity must never populate
// a query observed by the new identity. The revision is also part of every key.
tokenStore.subscribe(() => queryClient.clear());

export async function invalidateKnowledgeBaseOptionsAfter<T>(request: Promise<T>): Promise<T> {
  const revision = tokenStore.getRevision();
  const result = await request;
  if (revision === tokenStore.getRevision()) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: knowledgeBaseOptionsKey }),
      queryClient.invalidateQueries({ queryKey: knowledgeBaseListKey, refetchType: 'none' }),
      queryClient.invalidateQueries({ queryKey: knowledgeBaseDetailKey, refetchType: 'none' }),
      queryClient.invalidateQueries({ queryKey: homeSummaryKey }),
      queryClient.invalidateQueries({ queryKey: homeActivitiesKey }),
    ]);
  }
  return result;
}

export async function invalidateDocumentQueriesAfter<T>(request: Promise<T>): Promise<T> {
  const revision = tokenStore.getRevision();
  const result = await request;
  if (revision === tokenStore.getRevision()) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: documentListKey, refetchType: 'none' }),
      queryClient.invalidateQueries({ queryKey: documentCountsKey, refetchType: 'none' }),
      queryClient.invalidateQueries({ queryKey: knowledgeBaseDetailKey, refetchType: 'none' }),
      queryClient.invalidateQueries({ queryKey: homeSummaryKey }),
      queryClient.invalidateQueries({ queryKey: homeActivitiesKey }),
    ]);
  }
  return result;
}
