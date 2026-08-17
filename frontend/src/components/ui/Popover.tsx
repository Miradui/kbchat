import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

type Align = 'start' | 'end';

type PopoverProps = {
  /** Renders the trigger. `props` must be spread onto a focusable element. */
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: () => void;
    'aria-expanded': boolean;
    'aria-haspopup': 'menu';
  }) => ReactNode;
  label: string;
  align?: Align;
  width?: number;
  children: (close: () => void) => ReactNode;
};

const INSET = 8;

/**
 * Anchored floating panel. Unlike OverflowMenu it takes arbitrary content, so it
 * is used for the account menu and filter popovers.
 */
export function Popover({ trigger, label, align = 'end', width = 220, children }: PopoverProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: INSET, top: INSET });

  const place = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const height = panelRef.current?.offsetHeight ?? 0;
    const maxLeft = Math.max(INSET, window.innerWidth - width - INSET);
    const rawLeft = align === 'end' ? rect.right - width : rect.left;
    const below = rect.bottom + 4;
    const fitsBelow = below + height <= window.innerHeight - INSET;
    setPosition({
      left: Math.min(Math.max(INSET, rawLeft), maxLeft),
      top: fitsBelow ? below : Math.max(INSET, rect.top - height - 4),
    });
  }, [align, width]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((value) => !value),
        'aria-expanded': open,
        'aria-haspopup': 'menu',
      })}
      {open && createPortal(
        <div
          aria-label={label}
          className="ui-popover"
          onKeyDown={onKeyDown}
          ref={panelRef}
          role="menu"
          style={{ left: position.left, top: position.top, width }}
        >
          {children(close)}
        </div>,
        document.body,
      )}
    </>
  );
}
