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
});
