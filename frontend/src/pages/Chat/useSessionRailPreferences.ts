import { useCallback, useSyncExternalStore } from 'react';
import { queryClient } from '../../store/queryClient';
import { tokenStore } from '../../store/tokenStore';
import type { ChatSessionScope } from './ChatSessionRail';

type Preferences = { knowledgeBaseId: string; scope: ChatSessionScope; collapsed?: boolean };
const initial: Preferences = { knowledgeBaseId: '', scope: 'active' };

/** In-memory navigation state is cleared with the rest of the account cache. */
export function useSessionRailPreferences() {
  const revision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision);
  const subscribe = useCallback((listener: () => void) => queryClient.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey[0] === 'chat-rail-preferences' && query.queryKey[1] === revision) listener();
  }), [revision]);
  const getSnapshot = useCallback(() => queryClient.getQueryData<Preferences>(['chat-rail-preferences', revision]) ?? initial, [revision]);
  const preferences = useSyncExternalStore(subscribe, getSnapshot);
  const update = useCallback((next: Preferences) => {
    if (tokenStore.getRevision() !== revision) return;
    const current = getSnapshot();
    if (current.knowledgeBaseId !== next.knowledgeBaseId || current.scope !== next.scope || Boolean(current.collapsed) !== Boolean(next.collapsed)) {
      queryClient.setQueryData(['chat-rail-preferences', revision], next);
    }
  }, [getSnapshot, revision]);
  return [preferences, update] as const;
}
