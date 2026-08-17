import { Check, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { IconButton } from './IconButton';

type InlineEditProps = {
  value: string;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  /** Rendered when not editing. Defaults to the value. */
  emptyText?: string;
  onSubmit: (next: string) => void;
};

/**
 * Click-to-edit text. Replaces the pattern of parking a permanent text input and
 * a "rename" button in a header.
 */
export function InlineEdit({
  value,
  label,
  placeholder,
  disabled = false,
  busy = false,
  emptyText = '未命名',
  onSubmit,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value) onSubmit(next);
  }

  if (!editing) {
    return (
      <span className="ui-inline-edit">
        <span className="ui-inline-edit__text">{value.trim() || emptyText}</span>
        {!disabled && (
          <IconButton
            className="ui-inline-edit__trigger"
            label={label}
            onClick={() => setEditing(true)}
          >
            <Pencil aria-hidden="true" />
          </IconButton>
        )}
      </span>
    );
  }

  return (
    <form className="ui-inline-edit is-editing" onSubmit={commit}>
      <input
        aria-label={label}
        className="ui-input"
        disabled={busy || disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setEditing(false);
          }
        }}
        placeholder={placeholder}
        ref={inputRef}
        value={draft}
      />
      <IconButton disabled={busy || disabled || !draft.trim()} label="保存" type="submit">
        <Check aria-hidden="true" />
      </IconButton>
      <IconButton disabled={busy || disabled} label="取消" onClick={() => setEditing(false)}>
        <X aria-hidden="true" />
      </IconButton>
    </form>
  );
}
