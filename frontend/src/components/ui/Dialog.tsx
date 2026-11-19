import { useId } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useModalFocus } from './useModalFocus';

export { useModalFocus as useDialogModal } from './useModalFocus';

type DialogProps = {
  className?: string;
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
};

export function Dialog({ className = '', open, title, description, onClose, children }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useModalFocus<HTMLDivElement>(open, onClose);

  if (!open) return null;

  return createPortal(
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
        className={`ui-dialog ${className}`.trim()}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 id={titleId}>{title}</h2>
        {description && <p id={descriptionId}>{description}</p>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
