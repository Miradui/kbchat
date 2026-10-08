import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { IconButton } from './IconButton';
import { useModalFocus } from './useModalFocus';

type DrawerProps = {
  open: boolean;
  title: string;
  /** Rendered on the right of the header, before the close button. */
  headerActions?: ReactNode;
  wide?: boolean;
  className?: string;
  onClose: () => void;
  children: ReactNode;
};

export function Drawer({ open, title, headerActions, wide = false, className = '', onClose, children }: DrawerProps) {
  const titleId = useId();
  const panelRef = useModalFocus<HTMLElement>(open, onClose);

  if (!open) return null;

  return createPortal(
    <div
      className="ui-drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-labelledby={titleId}
        aria-modal="true"
        className={`${wide ? 'ui-drawer ui-drawer--wide' : 'ui-drawer'} ${className}`.trim()}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="ui-drawer__head">
          <h2 id={titleId}>{title}</h2>
          <div className="ui-drawer__head-actions">
            {headerActions}
            <IconButton label="关闭" onClick={onClose}><X aria-hidden="true" /></IconButton>
          </div>
        </header>
        <div className="ui-drawer__body">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
