/** A per-thread buffer: only subscribers to the transient answer render on deltas. */
export function createStreamText() {
  let value = '';
  let pending = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (value === pending) return;
    value = pending;
    listeners.forEach((listener) => listener());
  }
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) document.addEventListener('visibilitychange', flush);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) document.removeEventListener('visibilitychange', flush);
      };
    },
    set(text: string) {
      pending = text;
      // Show the first token immediately; clearing also invalidates a queued publish.
      if (!value || !text) flush();
      else if (timer === null) timer = setTimeout(flush, 50);
    },
    flush,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export type StreamText = ReturnType<typeof createStreamText>;
