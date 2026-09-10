import { useEffect, useRef } from 'react';

type ModalEntry = {
  id: symbol;
  onClose: () => void;
  originalAriaHidden: string | null;
  originalInert: boolean;
  panel: HTMLElement;
  restoreFocus: HTMLElement | null;
};

type BackgroundState = {
  ariaHidden: string | null;
  inert: boolean;
};

const modalStack: ModalEntry[] = [];
const isolatedBackground = new Map<HTMLElement, BackgroundState>();
let originalBodyOverflow = '';

function getFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.tabIndex >= 0 && canRestoreFocus(element));
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected
    || element.matches(':disabled, input[type="hidden"]')
    || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const visibility = getComputedStyle(element).visibility;
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  // A child's display value does not reflect a display:none ancestor.
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (getComputedStyle(current).display === 'none') return false;
  }
  return true;
}

function focusModal(entry: ModalEntry) {
  const requestedInitialFocus = entry.panel.querySelector<HTMLElement>('[data-autofocus]');
  (canRestoreFocus(requestedInitialFocus) ? requestedInitialFocus : getFocusable(entry.panel)[0] ?? entry.panel).focus();
}

function concealModal(entry: ModalEntry) {
  entry.panel.setAttribute('inert', '');
  entry.panel.setAttribute('aria-hidden', 'true');
}

function revealModal(entry: ModalEntry) {
  if (entry.originalInert) {
    entry.panel.setAttribute('inert', '');
  } else {
    entry.panel.removeAttribute('inert');
  }
  if (entry.originalAriaHidden === null) {
    entry.panel.removeAttribute('aria-hidden');
  } else {
    entry.panel.setAttribute('aria-hidden', entry.originalAriaHidden);
  }
}

function restoreBackgroundIsolation() {
  isolatedBackground.forEach((state, element) => {
    if (state.inert) {
      element.setAttribute('inert', '');
    } else {
      element.removeAttribute('inert');
    }
    if (state.ariaHidden === null) {
      element.removeAttribute('aria-hidden');
    } else {
      element.setAttribute('aria-hidden', state.ariaHidden);
    }
  });
  isolatedBackground.clear();
}

function isolateBackgroundForTopModal() {
  restoreBackgroundIsolation();
  const topModal = modalStack[modalStack.length - 1];
  if (!topModal) return;

  let current: HTMLElement | null = topModal.panel;
  while (current && current !== document.body) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) break;
    Array.from(parent.children).forEach((sibling) => {
      if (sibling === current || !(sibling instanceof HTMLElement)) return;
      if (sibling.matches('[data-modal-live-region]')) return;
      isolatedBackground.set(sibling, {
        ariaHidden: sibling.getAttribute('aria-hidden'),
        inert: sibling.hasAttribute('inert'),
      });
      sibling.setAttribute('inert', '');
      sibling.setAttribute('aria-hidden', 'true');
    });
    current = parent;
  }
}

function onModalKeyDown(event: KeyboardEvent) {
  const entry = modalStack[modalStack.length - 1];
  if (!entry) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    entry.onClose();
    return;
  }
  if (event.key !== 'Tab') return;

  const controls = getFocusable(entry.panel);
  if (controls.length === 0) {
    event.preventDefault();
    entry.panel.focus();
    return;
  }

  const first = controls[0];
  const last = controls[controls.length - 1];
  const activeElement = document.activeElement;
  if (event.shiftKey && (activeElement === first || !entry.panel.contains(activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeElement === last || !entry.panel.contains(activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

export function useModalFocus<T extends HTMLElement>(active: boolean, onClose: () => void) {
  const panelRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;

    const panel = panelRef.current;
    if (!panel) return;

    const entry: ModalEntry = {
      id: Symbol('modal'),
      onClose: () => onCloseRef.current(),
      originalAriaHidden: panel.getAttribute('aria-hidden'),
      originalInert: panel.hasAttribute('inert'),
      panel,
      restoreFocus: document.activeElement as HTMLElement | null,
    };

    if (modalStack.length === 0) {
      originalBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', onModalKeyDown);
    }
    const previousTopModal = modalStack[modalStack.length - 1];
    modalStack.push(entry);
    if (previousTopModal && !previousTopModal.panel.contains(entry.panel)) {
      concealModal(previousTopModal);
    }
    isolateBackgroundForTopModal();
    focusModal(entry);

    return () => {
      const index = modalStack.findIndex((candidate) => candidate.id === entry.id);
      if (index === -1) return;

      const wasTopModal = index === modalStack.length - 1;
      modalStack.splice(index, 1);
      const nextModal = modalStack[index];
      if (
        !wasTopModal
        && nextModal
        && (
          !nextModal.restoreFocus
          || !nextModal.restoreFocus.isConnected
          || entry.panel.contains(nextModal.restoreFocus)
        )
      ) {
        nextModal.restoreFocus = entry.restoreFocus;
      }

      if (modalStack.length === 0) {
        document.removeEventListener('keydown', onModalKeyDown);
        document.body.style.overflow = originalBodyOverflow;
      }

      isolateBackgroundForTopModal();

      if (!wasTopModal) return;
      const nextTopModal = modalStack[modalStack.length - 1];
      if (nextTopModal) {
        revealModal(nextTopModal);
      }
      if (
        canRestoreFocus(entry.restoreFocus)
        && (!nextTopModal || nextTopModal.panel.contains(entry.restoreFocus))
      ) {
        entry.restoreFocus.focus();
      } else if (nextTopModal) {
        focusModal(nextTopModal);
      } else {
        const fallback = document.querySelector<HTMLElement>('[data-modal-focus-fallback]');
        if (canRestoreFocus(fallback)) {
          fallback.focus();
        }
      }
    };
  }, [active]);

  return panelRef;
}
