import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

type Reader<T> = (raw: string | null) => T;

/**
 * Reads and writes a single query parameter.
 *
 * Filters, scope, sort and paging live in the URL so a filtered view is
 * shareable and the back button restores it. Values equal to `fallback` are
 * removed from the URL to keep it readable.
 */
export function useUrlState<T extends string | number>(
  key: string,
  fallback: T,
  parse?: Reader<T>,
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(key);

  const value = useMemo<T>(() => {
    if (parse) return parse(raw);
    if (raw === null) return fallback;
    return (typeof fallback === 'number' ? (Number(raw) as T) : (raw as T));
  }, [fallback, parse, raw]);

  const set = useCallback((next: T, options?: { replace?: boolean; resets?: string[] }) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === fallback || next === '' || next === null || next === undefined) {
        params.delete(key);
      } else {
        params.set(key, String(next));
      }
      options?.resets?.forEach((resetKey) => params.delete(resetKey));
      return params;
    }, { replace: options?.replace ?? false });
  }, [fallback, key, setSearchParams]);

  return [value, set] as const;
}

export function readEnum<T extends string>(allowed: readonly T[], fallback: T): Reader<T> {
  return (raw) => (raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback);
}

export function readPositiveInt(fallback: number, max?: number): Reader<number> {
  return (raw) => {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
    return max ? Math.min(parsed, max) : parsed;
  };
}
