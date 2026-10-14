import { useEffect, useState } from 'react';

import { searchChatMessages } from '../../api/resources';
import { useDebouncedValue } from '../../hooks/useMediaQuery';
import type { ChatMessageSearchResponse } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

export const CHAT_SEARCH_PAGE_SIZE = 20;

/** Search results are deliberately not cached: every read rechecks transcript access. */
export function useChatSearch(query: string, page: number, enabled: boolean, sessionId?: string) {
  const term = query.trim();
  const debounced = useDebouncedValue(term, 250);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; data?: ChatMessageSearchResponse; error?: string; cause?: unknown }>({ key: '' });
  const key = JSON.stringify([term, sessionId, page, attempt]);
  const ready = enabled && Boolean(term) && term === debounced;

  useEffect(() => {
    if (!ready) { setState({ key: '' }); return; }
    const controller = new AbortController();
    setState({ key });
    void searchChatMessages({ q: term, sessionId, page, pageSize: CHAT_SEARCH_PAGE_SIZE }, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ key, data }); },
      (cause: unknown) => {
        if (!controller.signal.aborted) setState({ key, cause, error: getErrorMessage(cause, '消息搜索失败，请重试。') });
      },
    );
    return () => controller.abort();
  }, [ready, key, term, page, sessionId]);

  const current = ready && state.key === key ? state : undefined;
  return {
    items: current?.data?.items ?? [], total: current?.data?.total ?? 0,
    loading: enabled && Boolean(term) && !current?.data && !current?.error,
    error: current?.error ?? '', cause: current?.cause,
    retry: () => setAttempt((value) => value + 1),
  };
}
