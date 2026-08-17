import { cloneElement, forwardRef, isValidElement, useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { classNames } from '../../utils/classNames';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input {...props} className={classNames('ui-input', className)} ref={ref} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea {...props} className={classNames('ui-textarea', className)} ref={ref} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    return <select {...props} className={classNames('ui-select', className)} ref={ref} />;
  },
);

export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  function Checkbox({ className, ...props }, ref) {
    return <input {...props} className={classNames('ui-checkbox', className)} ref={ref} type="checkbox" />;
  },
);

type FieldProps = {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  messageId?: string;
  children: ReactNode;
};

/**
 * Label + control + hint/error.
 *
 * The hint and error are wired to the control through `aria-describedby`, and an
 * error also sets `aria-invalid` and is announced. A styled `<p>` alone would be
 * invisible to screen readers, so the single child element is cloned to carry
 * those attributes.
 */
export function Field({ label, htmlFor, hint, error, messageId, children }: FieldProps) {
  const generatedId = useId();
  const errorId = messageId ?? `${generatedId}-error`;
  const hintId = messageId ?? `${generatedId}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  const control = isValidElement(children) && describedBy
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
      'aria-describedby': [
        (children.props as Record<string, unknown>)['aria-describedby'],
        describedBy,
      ].filter(Boolean).join(' '),
      'aria-invalid': error
        ? true
        : (children.props as Record<string, unknown>)['aria-invalid'],
    })
    : children;

  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={htmlFor}>{label}</label>
      {control}
      {error
        ? <p className="ui-field__error" id={errorId} role="alert">{error}</p>
        : hint
          ? <p className="ui-field__hint" id={hintId}>{hint}</p>
          : null}
    </div>
  );
}

type SearchInputProps = InputHTMLAttributes<HTMLInputElement> & {
  icon: ReactNode;
  trailing?: ReactNode;
};

export function SearchInput({ icon, trailing, className, ...props }: SearchInputProps) {
  return (
    <div className={classNames('ui-input-group', className)}>
      {icon}
      <input {...props} className="ui-input" type="search" />
      {trailing && <span className="ui-input-group__trailing">{trailing}</span>}
    </div>
  );
}
