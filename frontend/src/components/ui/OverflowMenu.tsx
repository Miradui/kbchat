import { MoreHorizontal } from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { IconButton } from './IconButton';

export type OverflowMenuItem = {
  label: string;
  icon?: ReactNode;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onSelect: () => void;
};

type OverflowMenuProps = {
  label: string;
  items: OverflowMenuItem[];
  disabled?: boolean;
};

const menuWidth = 192;
const viewportInset = 8;

export function OverflowMenu({ label, items, disabled = false }: OverflowMenuProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: viewportInset, top: viewportInset });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? items.length * 40 + 8;
    const maxLeft = Math.max(viewportInset, window.innerWidth - menuWidth - viewportInset);
    const left = Math.min(Math.max(viewportInset, rect.right - menuWidth), maxLeft);
    const below = rect.bottom + 4;
    const top = below + menuHeight <= window.innerHeight - viewportInset
      ? below
      : Math.max(viewportInset, rect.top - menuHeight - 4);
    setPosition({ left, top });
  }, [items.length]);

  useEffect(() => {
    if (!open) return;

    updatePosition();
    const firstEnabledItem = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    (firstEnabledItem ?? menuRef.current)?.focus();

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    function handleScrollOrResize() {
      updatePosition();
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
    };
  }, [open, updatePosition]);

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    );
    if (controls.length === 0) return;
    const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') {
      controls[0]?.focus();
    } else if (event.key === 'End') {
      controls.at(-1)?.focus();
    } else {
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (currentIndex + direction + controls.length) % controls.length;
      controls[nextIndex]?.focus();
    }
  }

  return (
    <span className="ui-overflow-menu-trigger">
      <IconButton
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        label={label}
        ref={triggerRef}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal aria-hidden="true" />
      </IconButton>
      {open && createPortal(
        <div
          aria-label={label}
          className="ui-overflow-menu"
          id={menuId}
          ref={menuRef}
          role="menu"
          style={{ left: position.left, top: position.top }}
          tabIndex={-1}
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item) => (
            <button
              className={item.tone === 'danger' ? 'ui-overflow-menu__item is-danger' : 'ui-overflow-menu__item'}
              disabled={item.disabled}
              key={item.label}
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
                item.onSelect();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}
