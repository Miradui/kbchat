import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';

import { SearchInput } from './Field';

type Props = Omit<ComponentProps<typeof SearchInput>, 'value' | 'onChange'> & {
  value: string;
  onCommit: (value: string) => void;
  resetKey?: string;
};

/** Keep typing local; explicit submission and clearing never wait for the timer. */
export function DebouncedSearchInput({ value, onCommit, resetKey, ...props }: Props) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  const commitRef = useRef(onCommit);
  const valueRef = useRef(value);

  useLayoutEffect(() => {
    commitRef.current = onCommit;
    valueRef.current = value;
  });

  function cancel() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }

  useEffect(() => {
    cancel();
    setDraft(value);
    return cancel;
  }, [value, resetKey]);

  function commit(raw: string) {
    cancel();
    const next = raw.trim();
    if (next !== valueRef.current) {
      valueRef.current = next;
      commitRef.current(next);
    }
  }

  function schedule(raw: string) {
    cancel();
    if (composing.current) return;
    if (!raw.trim()) commit(raw);
    else timer.current = setTimeout(() => commit(raw), 250);
  }

  return <SearchInput {...props} value={draft}
    onChange={(event) => { setDraft(event.target.value); schedule(event.target.value); }}
    onCompositionStart={() => { composing.current = true; cancel(); }}
    onCompositionEnd={(event) => { composing.current = false; schedule(event.currentTarget.value); }}
    onKeyDown={(event) => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composing.current) {
        event.preventDefault();
        commit(event.currentTarget.value);
      }
    }}
  />;
}
