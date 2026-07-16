import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

type DialogProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
};

const modalStack: symbol[] = [];
let bodyOverflowBeforeModals: string | null = null;

function registerModal(id: symbol) {
  if (modalStack.length === 0) {
    bodyOverflowBeforeModals = document.body.style.overflow;
  }
  modalStack.push(id);
  document.body.style.overflow = 'hidden';
}

function unregisterModal(id: symbol): boolean {
  const index = modalStack.lastIndexOf(id);
  const wasTop = index === modalStack.length - 1;
  if (index >= 0) {
    modalStack.splice(index, 1);
  }
  if (modalStack.length === 0) {
    document.body.style.overflow = bodyOverflowBeforeModals ?? '';
    bodyOverflowBeforeModals = null;
  } else {
    document.body.style.overflow = 'hidden';
  }
  return wasTop;
}

function isTopModal(id: symbol): boolean {
  return modalStack[modalStack.length - 1] === id;
}

function getFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => (
    !element.matches(':disabled')
    && !element.hidden
    && element.getAttribute('aria-hidden') !== 'true'
    && !element.closest('[hidden], [inert], [aria-hidden="true"]')
  ));
}

export function Dialog({ open, title, description, onClose, children }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useDialogModal<HTMLDivElement>(open, onClose);

  if (!open) return null;

  return (
    <div
      className="ui-dialog-backdrop"
      data-testid="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="ui-dialog"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 id={titleId}>{title}</h2>
        {description && <p id={descriptionId}>{description}</p>}
        {children}
      </div>
    </div>
  );
}

export function useDialogModal<T extends HTMLElement = HTMLElement>(open: boolean, onClose: () => void) {
  const panelRef = useRef<T>(null);
  const modalIdRef = useRef(Symbol('modal'));
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const modalId = modalIdRef.current;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    registerModal(modalId);
    const firstControl = panel ? getFocusable(panel)[0] : undefined;
    (firstControl ?? panel)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (!isTopModal(modalId)) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;

      const controls = getFocusable(panel);
      if (controls.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !panel.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !panel.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const wasTop = unregisterModal(modalId);
      if (wasTop && restoreFocusRef.current?.isConnected) {
        restoreFocusRef.current.focus();
      }
    };
  }, [open]);

  return panelRef;
}
