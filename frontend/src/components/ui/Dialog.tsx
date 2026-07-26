import { useId } from 'react';
import type { ReactNode } from 'react';

import { useModalFocus } from './useModalFocus';

type DialogProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
};

export function Dialog({ open, title, description, onClose, children }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useModalFocus<HTMLDivElement>(open, onClose);

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
