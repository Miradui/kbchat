import { CornerDownLeft, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import { Button } from '../../components/ui/Button';

const MAX_HEIGHT = 200;

type ChatComposerProps = {
  value: string;
  disabled: boolean;
  sending: boolean;
  placeholder: string;
  /** Shown under the input, e.g. why sending is unavailable. */
  hint?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
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
  onChange,
  onSubmit,
  onCancel,
}: ChatComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

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
          <span className="chat-composer__hint">
            <kbd className="ui-kbd">Enter</kbd> 发送 · <kbd className="ui-kbd">Shift + Enter</kbd> 换行
          </span>
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
              disabled={disabled || !value.trim()}
              leadingIcon={<CornerDownLeft aria-hidden="true" />}
              type="submit"
            >
              发送
            </Button>
          )}
        </div>
      </div>
      {hint && <p className="chat-composer__note">{hint}</p>}
    </form>
  );
}
