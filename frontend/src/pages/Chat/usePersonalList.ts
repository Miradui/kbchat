import { useEffect, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useMediaQuery';
import type { PersonalListParams } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

export const PERSONAL_PAGE_SIZE = 20;

/** Personal resources are fetched on every open, without a cross-account cache. */
export function usePersonalList<T>(fetcher: (params: PersonalListParams, signal?: AbortSignal) => Promise<{ items: T[]; total: number }>, query: string, page: number, enabled = true) {
  const term = query.trim();
  const debounced = useDebouncedValue(term, 250);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; items?: T[]; total?: number; error?: string }>({ key: '' });
  const key = JSON.stringify([term, page, revision]);
  const ready = enabled && term === debounced;
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setState({ key });
    void fetcher({ q: term, page, pageSize: PERSONAL_PAGE_SIZE }, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ key, ...data }); },
      (error: unknown) => { if (!controller.signal.aborted) setState({ key, error: getErrorMessage(error, '加载失败，请重试。') }); },
    );
    return () => controller.abort();
  }, [fetcher, key, page, ready, term]);
  const current = ready && state.key === key ? state : undefined;
  return { items: current?.items ?? [], total: current?.total ?? 0, error: current?.error ?? '',
    loading: !current?.items && !current?.error, refresh: () => setRevision((value) => value + 1) };
}
