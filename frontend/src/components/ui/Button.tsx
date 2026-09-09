import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { classNames } from '../../utils/classNames';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  loadingLabel?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

export function Button({
  variant = 'primary',
  loading = false,
  loadingLabel = '处理中',
  leadingIcon,
  trailingIcon,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={classNames('ui-button', 'ui-button--' + variant, className)}
      disabled={disabled || loading}
      type={type}
    >
      {loading ? <LoaderCircle className="ui-button__spinner" aria-hidden="true" /> : leadingIcon}
      <span>{loading ? loadingLabel : children}</span>
      {!loading && trailingIcon}
    </button>
  );
}
