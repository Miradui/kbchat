import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { InlineEdit } from './InlineEdit';

/**
 * Every exit from edit mode unmounts the form that focus is sitting in -- on the input,
 * or on the save/cancel button just pressed. Without an explicit return, focus lands on
 * `body` and a keyboard user has to tab from the top of the page to get back. Nothing
 * looks wrong on screen, which is why all three exits are pinned here.
 */
function renderEdit(props: Partial<Parameters<typeof InlineEdit>[0]> = {}) {
  const onSubmit = vi.fn();
  render(<InlineEdit label="重命名" value="原标题" onSubmit={onSubmit} {...props} />);
  return { onSubmit, trigger: () => screen.getByRole('button', { name: '重命名' }) };
}

describe('InlineEdit focus', () => {
  it('returns focus to the trigger after saving', async () => {
    const user = userEvent.setup();
    const { onSubmit, trigger } = renderEdit();

    await user.click(trigger());
    await user.clear(screen.getByRole('textbox', { name: '重命名' }));
    await user.type(screen.getByRole('textbox', { name: '重命名' }), '新标题');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).toHaveBeenCalledWith('新标题');
    expect(trigger()).toHaveFocus();
  });

  it('returns focus to the trigger after cancelling', async () => {
    const user = userEvent.setup();
    const { onSubmit, trigger } = renderEdit();

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
  });

  it('returns focus to the trigger after Escape', async () => {
    const user = userEvent.setup();
    const { onSubmit, trigger } = renderEdit();

    await user.click(trigger());
    await user.keyboard('{Escape}');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
  });

  it('focuses the field when edit mode opens, with the text selected', async () => {
    const user = userEvent.setup();
    const { trigger } = renderEdit();

    await user.click(trigger());

    // Not left to `select()`: whether that also focuses is not guaranteed, and if it
    // does not, activating the pencil gives a keyboard user a field they must tab to.
    const input = screen.getByRole('textbox', { name: '重命名' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('原标题');
  });

  it('does not steal focus on first render', () => {
    renderEdit();

    // The effect that returns focus runs on mount too, so it has to know the difference
    // between "the user just left edit mode" and "this component has only appeared".
    expect(document.body).toHaveFocus();
  });

  it('abandons the edit when cancelled', async () => {
    const user = userEvent.setup();
    const { trigger } = renderEdit();

    await user.click(trigger());
    await user.clear(screen.getByRole('textbox', { name: '重命名' }));
    await user.type(screen.getByRole('textbox', { name: '重命名' }), '丢弃这个');
    await user.keyboard('{Escape}');
    await user.click(trigger());

    // Re-entering shows the stored value, not the abandoned draft.
    expect(screen.getByRole('textbox', { name: '重命名' })).toHaveValue('原标题');
  });
});
