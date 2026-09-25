import { useCallback, useLayoutEffect, useRef } from 'react';

/** Stable UI handler identity with the latest committed state. */
export function useEventCallback<Args extends unknown[], Result>(handler: (...args: Args) => Result) {
  const latest = useRef(handler);
  useLayoutEffect(() => { latest.current = handler; }, [handler]);
  return useCallback((...args: Args) => latest.current(...args), []);
}
