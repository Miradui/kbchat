import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { classNames } from '../../utils/classNames';

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
  label: string;
  children: ReactNode;
  tone?: 'default' | 'danger';
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label,
  children,
  tone = 'default',
  className,
  type = 'button',
  ...props
}, ref) {
  return (
    <button
      {...props}
      aria-label={label}
      className={classNames('ui-icon-button', tone === 'danger' && 'ui-icon-button--danger', className)}
      ref={ref}
      title={label}
      type={type}
    >
      {children}
    </button>
  );
});
