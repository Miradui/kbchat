import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { getCurrentUser } from '../api/resources';
import { currentUserStore } from '../store/currentUserStore';
import { tokenStore } from '../store/tokenStore';
import type { User } from '../types/api';
import { getErrorMessage } from '../utils/errors';

type UserRequest = () => Promise<User>;
type UserState = { revision: number; request: UserRequest; user: User | null; loading: boolean; error: string };

export function useCurrentUser(request: UserRequest = getCurrentUser) {
  const revision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<UserState>(() => {
    const user = currentUserStore.getCached(request);
    return { revision, request, user, loading: !user, error: '' };
  });

  useEffect(() => {
    let active = true;
    const cached = currentUserStore.getCached(request);
    setState({ revision, request, user: cached, loading: !cached, error: '' });
    if (cached) return;
    void currentUserStore.load(request).then((user) => {
      if (!user) throw new Error('无法获取当前账号');
      if (active && tokenStore.getRevision() === revision) {
        setState({ revision, request, user, loading: false, error: '' });
      }
    }).catch((error: unknown) => {
      if (active && tokenStore.getRevision() === revision) {
        setState({ revision, request, user: null, loading: false, error: getErrorMessage(error, '无法获取当前账号') });
      }
    });
    return () => { active = false; };
  }, [request, revision, attempt]);

  const reload = useCallback(() => {
    currentUserStore.clear();
    setAttempt((value) => value + 1);
  }, []);
  // An account switch must hide the previous role before the next effect runs.
  const current = state.revision === revision && state.request === request
    ? state
    : { user: null, loading: true, error: '' };
  return { user: current.user, loading: current.loading, error: current.error, reload };
}
