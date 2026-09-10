import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';

import { IconButton } from '../../components/ui/IconButton';

export function ChatAnswerVersionNavigation({ index, count, disabled, onChange }: {
  index: number;
  count: number;
  disabled: boolean;
  onChange: (index: number) => void;
}) {
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const focusDirection = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (focusDirection.current === null) return;
    const preferred = focusDirection.current < 0 ? previous.current : next.current;
    const fallback = focusDirection.current < 0 ? next.current : previous.current;
    (preferred?.disabled ? fallback : preferred)?.focus({ preventScroll: true });
    focusDirection.current = null;
  }, [index]);
  function move(direction: number) {
    focusDirection.current = direction;
    onChange(index + direction);
  }
  return <div aria-label="回答版本" className="chat-msg__versions" role="group">
    <IconButton ref={previous} disabled={disabled || index === 0} label="上一版回答" onClick={() => move(-1)}><ChevronLeft aria-hidden="true" /></IconButton>
    <span aria-label={`第 ${index + 1} 版回答，共 ${count} 版`}>{index + 1} / {count}</span>
    <IconButton ref={next} disabled={disabled || index === count - 1} label="下一版回答" onClick={() => move(1)}><ChevronRight aria-hidden="true" /></IconButton>
  </div>;
}
