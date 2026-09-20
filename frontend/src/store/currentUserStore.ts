import type { User } from '../types/api';
import { tokenStore } from './tokenStore';

type CurrentUserRequest = () => Promise<User>;

type CacheEntry = {
  request: CurrentUserRequest;
  revision: number;
  pending: Promise<User> | null;
  user: User | null;
};

let cache: CacheEntry | null = null;

export const currentUserStore = {
  load(request: CurrentUserRequest): Promise<User> {
    const revision = tokenStore.getRevision();
    if (!cache || cache.request !== request || cache.revision !== revision) {
      cache = { request, revision, pending: null, user: null };
    }
    if (cache.user) {
      return Promise.resolve(cache.user);
    }
    if (cache.pending) {
      return cache.pending;
    }

    const entry = cache;
    const pending = Promise.resolve().then(request)
      .then((user) => {
        if (cache === entry && tokenStore.getRevision() === revision) {
          entry.user = user;
        }
        return user;
      })
      .finally(() => {
        if (cache === entry && entry.pending === pending) {
          entry.pending = null;
        }
      });
    entry.pending = pending;
    return pending;
  },

  clear(): void {
    cache = null;
  },
};
