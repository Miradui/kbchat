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
  type RefObject,
} from 'react';

import { IconButton } from './IconButton';
import { moveMenuFocus } from './menuFocus';

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
  /** Also open this menu from a row's context menu or Shift+F10. */
  contextTargetRef?: RefObject<HTMLElement | null>;
};

const menuWidth = 192;
const viewportInset = 8;

export function OverflowMenu({ label, items, disabled = false, contextTargetRef }: OverflowMenuProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const contextPositionRef = useRef<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: viewportInset, top: viewportInset });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? items.length * 40 + 8;
    const maxLeft = Math.max(viewportInset, window.innerWidth - menuWidth - viewportInset);
    const point = contextPositionRef.current;
    if (point) {
      setPosition({
        left: Math.min(Math.max(viewportInset, point.x), maxLeft),
        top: Math.min(Math.max(viewportInset, point.y), Math.max(viewportInset, window.innerHeight - menuHeight - viewportInset)),
      });
      return;
    }
    const left = Math.min(Math.max(viewportInset, rect.right - menuWidth), maxLeft);
    const below = rect.bottom + 4;
    const top = below + menuHeight <= window.innerHeight - viewportInset
      ? below
      : Math.max(viewportInset, rect.top - menuHeight - 4);
    setPosition({ left, top });
  }, [items.length]);

  useEffect(() => {
    const target = contextTargetRef?.current;
    if (!target) return;
    function handleContextMenu(event: MouseEvent) {
      if (disabled) return;
      event.preventDefault();
      contextPositionRef.current = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : null;
      updatePosition();
      setOpen(true);
    }
    function handleContextKey(event: globalThis.KeyboardEvent) {
      if (disabled || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
      event.preventDefault();
      contextPositionRef.current = null;
      updatePosition();
      setOpen(true);
    }
    target.addEventListener('contextmenu', handleContextMenu);
    target.addEventListener('keydown', handleContextKey);
    return () => {
      target.removeEventListener('contextmenu', handleContextMenu);
      target.removeEventListener('keydown', handleContextKey);
    };
  }, [contextTargetRef, disabled, updatePosition]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

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
      /*
        Same contract as Popover: prevent the default, close, return to the trigger. The
        menu is portaled to the end of `body` and React has not unmounted it when the
        browser computes Tab's destination, so allowing the default moves focus into the
        panel that is about to vanish and focus is lost to `body`.
      */
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    moveMenuFocus(event, '[role="menuitem"]:not(:disabled)');
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
        onClick={() => {
          contextPositionRef.current = null;
          updatePosition();
          setOpen((current) => !current);
        }}
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
