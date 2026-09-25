import { QueryClient } from '@tanstack/react-query';
import { tokenStore } from './tokenStore';

export const knowledgeBaseOptionsKey = ['knowledge-base-options'] as const;
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

// Clear synchronously: a late request from a prior identity must never populate
// a query observed by the new identity. The revision is also part of every key.
tokenStore.subscribe(() => queryClient.clear());

export async function invalidateKnowledgeBaseOptionsAfter<T>(request: Promise<T>): Promise<T> {
  const revision = tokenStore.getRevision();
  const result = await request;
  if (revision === tokenStore.getRevision()) {
    await queryClient.invalidateQueries({ queryKey: knowledgeBaseOptionsKey });
  }
  return result;
}
