import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'rag.pref.';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/**
 * A purely local view preference.
 *
 * View mode and expanded category ids used to round-trip through
 * `PUT /knowledge-bases/workspace-preference`, which put a blocking network write
 * behind a checkbox and then disabled the page while it was in flight. These are
 * local display choices; they belong in localStorage and must apply instantly.
 */
export function useLocalPreference<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => read(key, fallback));

  const update = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => {
      const resolved = typeof next === 'function' ? (next as (c: T) => T)(current) : next;
      try {
        window.localStorage.setItem(PREFIX + key, JSON.stringify(resolved));
      } catch {
        // Private-mode or quota failures must not break the interaction.
      }
      return resolved;
    });
  }, [key]);

  // Keep tabs in sync without a server round-trip.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === PREFIX + key) setValue(read(key, fallback));
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
    // `fallback` is only read on a miss; excluding it avoids resubscribing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, update] as const;
}
