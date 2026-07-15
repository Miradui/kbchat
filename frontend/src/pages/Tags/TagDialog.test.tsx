import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import { TagDialog } from './TagDialog';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('TagDialog', () => {
  it('keeps the edited value and backend message after failure', async () => {
    const onSubmit = vi.fn(() => Promise.reject(
      new ApiError(409, { code: 'TAG_EXISTS', message: '标签名称已存在' }),
    ));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TagDialog open initialName="旧名称" title="编辑标签" onClose={onClose} onSubmit={onSubmit} />);

    const input = screen.getByLabelText('标签名称');
    await user.clear(input);
    await user.type(input, '替换名称');
    await user.click(screen.getByRole('button', { name: '保存标签' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('标签名称已存在');
    expect(input).toHaveValue('替换名称');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', alert.id);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('trims the name and closes after success', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TagDialog open initialName="  制度  " title="编辑标签" onClose={onClose} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: '保存标签' }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith('制度');
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('blocks cancel, Escape, and duplicate submit while saving', async () => {
    const pending = deferred();
    const onSubmit = vi.fn(() => pending.promise);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TagDialog open initialName="制度" title="编辑标签" onClose={onClose} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: '保存标签' }));
    expect(screen.getByRole('button', { name: '保存中' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.submit(screen.getByLabelText('标签名称').closest('form')!);

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
