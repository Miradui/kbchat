import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '../../test/render';
import { ChatFeedbackDialog } from './ChatFeedbackDialog';

describe('ChatFeedbackDialog', () => {
  it('keeps the reason and comment after failure and closes after a confirmed save', async () => {
    const user = userEvent.setup(), submit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true), close = vi.fn();
    renderWithRouter(<ChatFeedbackDialog onClose={close} onSubmit={submit} />);
    await user.selectOptions(screen.getByRole('combobox', { name: '差评原因' }), 'missing_evidence');
    await user.type(screen.getByRole('textbox', { name: '反馈补充说明' }), '缺少相关制度引用');
    await user.click(screen.getByRole('button', { name: '保存反馈' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('反馈未保存');
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '反馈补充说明' })).toHaveValue('缺少相关制度引用');
    await user.click(screen.getByRole('button', { name: '保存反馈' }));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenLastCalledWith({ reason: 'missing_evidence', comment: '缺少相关制度引用' });
  });
});
