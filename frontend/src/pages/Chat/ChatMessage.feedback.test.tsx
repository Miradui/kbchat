import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../types/api';
import { MessageBubble } from './ChatMessage';

const assistantMessage = {
  id: 'assistant-1',
  sessionId: 'session-1',
  role: 'assistant',
  content: '回答内容',
  citations: [],
  feedback: null,
  createdAt: '2026-08-10T00:00:00Z',
} satisfies ChatMessage;

function renderMessage(message: ChatMessage, props: Partial<ComponentProps<typeof MessageBubble>> = {}) {
  const defaults: ComponentProps<typeof MessageBubble> = {
    message,
    focusedCitationIndex: null,
    onFocusCitation: vi.fn(),
    canRegenerate: false,
    regenerating: false,
    onRegenerate: vi.fn(),
    feedbackSaving: false,
    onFeedback: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <MessageBubble {...defaults} {...props} />
    </MemoryRouter>,
  );
}

describe('MessageBubble feedback', () => {
  it('copies assistant and user messages and exposes edit controls', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const userMessage = {
      ...assistantMessage,
      id: 'user-1',
      role: 'user',
      content: '用户问题',
    } satisfies ChatMessage;
    const onStartEdit = vi.fn();
    renderMessage(userMessage, { onStartEdit });

    await user.click(screen.getByRole('button', { name: '复制消息' }));
    expect(writeText).toHaveBeenCalledWith('用户问题');
    await user.click(screen.getByRole('button', { name: '编辑消息' }));
    expect(onStartEdit).toHaveBeenCalledWith('user-1', '用户问题');
  });

  it('supports keyboard submit and cancel while editing', async () => {
    const user = userEvent.setup();
    const onSubmitEdit = vi.fn();
    const onCancelEdit = vi.fn();
    const userMessage = {
      ...assistantMessage,
      id: 'user-1',
      role: 'user',
      content: '用户问题',
    } satisfies ChatMessage;
    const view = renderMessage(userMessage, {
      editing: true,
      editDraft: '修改后的问题',
      onSubmitEdit,
      onCancelEdit,
    });
    const input = screen.getByRole('textbox', { name: '编辑消息' });
    await user.type(input, '{Control>}{Enter}{/Control}');
    expect(onSubmitEdit).toHaveBeenCalledWith('user-1', '修改后的问题');
    await user.keyboard('{Escape}');
    expect(onCancelEdit).toHaveBeenCalled();
    view.unmount();
  });

  it('submits positive and negative feedback for assistant answers', async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn();
    renderMessage(assistantMessage, { onFeedback });

    await user.click(screen.getByRole('button', { name: '标记回答有帮助' }));
    await user.click(screen.getByRole('button', { name: '标记回答没有帮助' }));

    expect(onFeedback).toHaveBeenNthCalledWith(1, assistantMessage.id, 'positive');
    expect(onFeedback).toHaveBeenNthCalledWith(2, assistantMessage.id, 'negative');
  });

  it('exposes the persisted selection and disables both buttons while saving', () => {
    renderMessage({
      ...assistantMessage,
      feedback: {
        messageId: assistantMessage.id,
        rating: 'positive',
        updatedAt: '2026-08-10T00:01:00Z',
      },
    }, { feedbackSaving: true });

    expect(screen.getByRole('button', { name: '标记回答有帮助' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '标记回答没有帮助' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '标记回答有帮助' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '标记回答没有帮助' })).toBeDisabled();
  });
});
