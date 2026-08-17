import type { ReactNode } from 'react';

import { classNames } from '../../utils/classNames';

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

type BadgeProps = {
  tone?: BadgeTone;
  /** Hides the leading status dot. Use for non-status labels. */
  plain?: boolean;
  title?: string;
  'aria-label'?: string;
  children: ReactNode;
};

export function Badge({ tone = 'neutral', plain = false, children, ...props }: BadgeProps) {
  return (
    <span {...props} className={classNames('ui-badge', `ui-badge--${tone}`, plain && 'ui-badge--plain')}>
      {children}
    </span>
  );
}
