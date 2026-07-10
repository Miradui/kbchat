import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { classNames } from '../../utils/classNames';

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
  label: string;
  children: ReactNode;
  tone?: 'default' | 'danger';
};

export function IconButton({
  label,
  children,
  tone = 'default',
  className,
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      aria-label={label}
      className={classNames('ui-icon-button', tone === 'danger' && 'ui-icon-button--danger', className)}
      title={label}
      type={type}
    >
      {children}
    </button>
  );
}
