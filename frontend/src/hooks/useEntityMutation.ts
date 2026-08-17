import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tracks in-flight mutations per entity id instead of holding one page-wide lock.
 *
 * The previous workspace used a single `mutationRef` that, while any write was in
 * flight, disabled every row action, the category tree, filters, sorting, the view
 * toggle and even navigation links. Favouriting one item froze the whole page.
 *
 * Here a mutation only ever blocks the keys it names. Filters, sorting, paging and
 * navigation are never gated on this hook.
 */
export function useEntityMutation() {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sync = useCallback(() => {
    if (mountedRef.current) setPending(new Set(pendingRef.current));
  }, []);

  const run = useCallback(async <T,>(key: string, action: () => Promise<T>): Promise<T | undefined> => {
    if (pendingRef.current.has(key)) return undefined;
    pendingRef.current.add(key);
    sync();
    try {
      return await action();
    } finally {
      pendingRef.current.delete(key);
      sync();
    }
  }, [sync]);

  const isPending = useCallback((key: string) => pending.has(key), [pending]);
  const isPendingSync = useCallback((key: string) => pendingRef.current.has(key), []);

  return {
    /** Runs `action` under `key`; a second call with the same key while pending is ignored. */
    run,
    isPending,
    /** Reads the ref synchronously for same-tick interaction guards. */
    isPendingSync,
    /** True when any mutation is running. Only use for aria-busy, never to disable navigation. */
    anyPending: pending.size > 0,
  };
}
