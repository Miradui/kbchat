import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ChatComposer } from './ChatComposer';

/**
 * The composer's keyboard behaviour is only exercised through the full ChatPage
 * elsewhere, which makes a regression here read as an unrelated page failure. These
 * cover it directly.
 */
function renderComposer(overrides: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const props = {
    value: '问题',
    disabled: false,
    sending: false,
    placeholder: '输入问题',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<ChatComposer {...props} />);
  return { props, input: screen.getByRole('textbox', { name: '输入问题' }) };
}

describe('ChatComposer', () => {
  it('tells the on-screen keyboard that Enter sends', () => {
    const { input } = renderComposer();

    // A textarea would otherwise offer a newline key, which is wrong for a field
    // where Enter submits -- and the on-screen Shift+Enter hint is hidden below 680px.
    expect(input).toHaveAttribute('enterkeyhint', 'send');
  });

  it('sends on Enter', async () => {
    const { props, input } = renderComposer();

    await userEvent.type(input, '{Enter}');

    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it('inserts a newline on Shift+Enter instead of sending', async () => {
    const { props, input } = renderComposer();

    await userEvent.type(input, '{Shift>}{Enter}{/Shift}');

    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('does not send while an IME is composing', () => {
    const { props, input } = renderComposer();

    // Committing a Chinese candidate with Enter must not also send the message.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('keeps a Chinese candidate in the draft when the keyboard omits isComposing', () => {
    const { props, input } = renderComposer();

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false });

    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue('问题');

    fireEvent.compositionEnd(input, { data: '问题' });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });

    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it('does not send on Safari candidate confirmation after compositionend', () => {
    const { props, input } = renderComposer();

    fireEvent.compositionStart(input);
    fireEvent.compositionEnd(input, { data: '问题' });
    // Safari can deliver compositionend before the confirming Enter, with
    // isComposing already false but the IME process key code still set.
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false });

    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue('问题');

    fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });

    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it('blocks form submission during composition and allows the send button after confirmation', async () => {
    const { props, input } = renderComposer();
    const form = input.closest('form');
    expect(form).not.toBeNull();

    fireEvent.compositionStart(input);
    fireEvent.submit(form!);

    expect(props.onSubmit).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { data: '问题' });
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it('does not send a blank message', async () => {
    const { props, input } = renderComposer({ value: '   ' });

    await userEvent.type(input, '{Enter}');

    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('offers cancel instead of send while a reply is streaming', async () => {
    const { props } = renderComposer({ sending: true });

    await userEvent.click(screen.getByRole('button', { name: '停止生成' }));

    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('associates a rate limit error with the input and announces it', () => {
    const { input } = renderComposer({ error: '请求过于频繁，请 12 秒后再试' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('请求过于频繁，请 12 秒后再试');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(input).toHaveAccessibleDescription('请求过于频繁，请 12 秒后再试');
  });
});
