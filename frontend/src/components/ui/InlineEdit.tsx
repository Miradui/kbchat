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
  /**
   * Saves the new value. Return `false`, or reject, to keep the field open with
   * what the user typed; anything else closes it.
   */
  onSubmit: (next: string) => unknown;
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  /* Whether the last exit from edit mode was the user's, so focus is only moved for a
     deliberate save/cancel and not when the component merely mounts unedited. */
  const returningFocusRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  useEffect(() => {
    if (!editing) return;
    // `focus` explicitly, not just `select`. Whether `select()` also focuses is not
    // something to rely on -- jsdom's does not -- and if it does not, activating the
    // pencil leaves a keyboard user with an edit field they still have to tab to.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  /*
    Leaving edit mode unmounts the form, and focus was inside it -- on the input, or on
    the save/cancel button that was just pressed. Without this, focus falls to `body` and
    a keyboard user has to tab from the top of the page again. Runs after the trigger has
    rendered, which is why it is an effect and not part of `stopEditing`.
  */
  useEffect(() => {
    if (editing || !returningFocusRef.current) return;
    returningFocusRef.current = false;
    triggerRef.current?.focus();
  }, [editing]);

  function stopEditing() {
    returningFocusRef.current = true;
    setEditing(false);
  }

  async function commit(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (!next || next === value) {
      stopEditing();
      return;
    }
    // Wait for the caller before leaving edit mode. A rejected save (duplicate
    // name, network, 5xx) used to close the field and discard the typed value, so
    // the user had to open it again and retype.
    let accepted: unknown;
    try {
      accepted = await onSubmit(next);
    } catch {
      return;
    }
    if (accepted === false) return;
    stopEditing();
  }

  if (!editing) {
    return (
      <span className="ui-inline-edit">
        <span className="ui-inline-edit__text">{value.trim() || emptyText}</span>
        {!disabled && (
          <IconButton
            className="ui-inline-edit__trigger"
            label={label}
            ref={triggerRef}
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
            stopEditing();
          }
        }}
        placeholder={placeholder}
        ref={inputRef}
        value={draft}
      />
      <IconButton disabled={busy || disabled || !draft.trim()} label="保存" type="submit">
        <Check aria-hidden="true" />
      </IconButton>
      <IconButton disabled={busy || disabled} label="取消" onClick={stopEditing}>
        <X aria-hidden="true" />
      </IconButton>
    </form>
  );
}
