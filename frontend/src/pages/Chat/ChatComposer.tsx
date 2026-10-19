import { ArrowUp, LayoutTemplate, Square } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';

import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { RetryCountdown } from '../../components/feedback/RetryCountdown';
import type { RetryNotice } from '../../components/feedback/RetryCountdown';

const MAX_HEIGHT = 200;

type ChatComposerProps = {
  value: string;
  disabled: boolean;
  sending: boolean;
  placeholder: string;
  /** Shown under the input, e.g. why sending is unavailable. */
  hint?: string;
  /** A recoverable request error shown next to the input. */
  error?: string;
  retryNotice?: RetryNotice | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onTemplates?: () => void;
  tools?: ReactNode;
};

/**
 * Auto-growing composer. Enter sends, Shift+Enter inserts a newline — the old
 * build used a fixed two-row textarea with no keyboard submit at all.
 */
export function ChatComposer({
  value,
  disabled,
  sending,
  placeholder,
  hint,
  error,
  retryNotice,
  onChange,
  onSubmit,
  onCancel,
  onTemplates,
  tools,
}: ChatComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const errorId = useId();
  const describedBy = [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (disabled || !value.trim()) return;
    onSubmit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // IME composition must not be interrupted mid-word.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  return (
    <form className="chat-composer" onSubmit={submit}>
      <div className="chat-composer__box">
        <textarea
          aria-describedby={describedBy}
          aria-label="输入问题"
          className="chat-composer__input"
          disabled={disabled}
          // A textarea normally gets a newline key. This one sends on Enter, so the
          // phone keyboard should say so -- Shift+Enter for a newline is a hardware
          // gesture anyway, and the on-screen hint next to it is hidden below 680px.
          enterKeyHint="send"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          ref={ref}
          rows={1}
          value={value}
        />
        <div className="chat-composer__actions">
          {tools && <div className="chat-composer__scope">{tools}</div>}
          <span className="chat-composer__spacer" />
          {onTemplates && <IconButton label="提问模板" disabled={disabled || sending} onClick={onTemplates}><LayoutTemplate aria-hidden="true" /></IconButton>}
          {sending ? (
            <Button
              leadingIcon={<Square aria-hidden="true" />}
              onClick={onCancel}
              variant="secondary"
            >
              停止生成
            </Button>
          ) : (
            <Button
              aria-label="发送"
              className="chat-composer__send"
              disabled={disabled || !value.trim()}
              trailingIcon={<ArrowUp aria-hidden="true" />}
              type="submit"
            >
              <span className="sr-only">发送</span>
            </Button>
          )}
        </div>
      </div>
      <span className="chat-composer__hint">Enter 发送 · Shift + Enter 换行</span>
      {hint && <p className="chat-composer__note" id={hintId}>{hint}</p>}
      {error && (
        <p
          aria-live="assertive"
          className="chat-composer__error ui-inline-error"
          id={errorId}
          role="alert"
        >
          {retryNotice ? <RetryCountdown notice={retryNotice} /> : error}
        </p>
      )}
    </form>
  );
}
