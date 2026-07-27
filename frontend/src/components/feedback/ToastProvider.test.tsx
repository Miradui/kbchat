import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider, useToast } from './ToastProvider';

function Probe() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success('保存成功')}>成功一</button>
      <button type="button" onClick={() => toast.success('发布成功')}>成功二</button>
      <button type="button" onClick={() => toast.error('保存失败')}>失败</button>
    </>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToastProvider', () => {
  it('mounts the live region beside portaled modal layers', () => {
    render(<ToastProvider><Probe /></ToastProvider>);

    expect(screen.getByRole('region', { name: '通知' }).parentElement).toBe(document.body);
  });

  it('queues success feedback and announces errors assertively', async () => {
    const user = userEvent.setup();
    render(<ToastProvider><Probe /></ToastProvider>);

    await user.click(screen.getByRole('button', { name: '成功一' }));
    await user.click(screen.getByRole('button', { name: '成功二' }));
    await user.click(screen.getByRole('button', { name: '失败' }));

    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败');
  });

  it('removes feedback after the visible interval', () => {
    vi.useFakeTimers();
    render(<ToastProvider><Probe /></ToastProvider>);

    fireEvent.click(screen.getByRole('button', { name: '成功一' }));
    act(() => vi.advanceTimersByTime(3500));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('clears pending timers when the provider unmounts', () => {
    vi.useFakeTimers();
    const { unmount } = render(<ToastProvider><Probe /></ToastProvider>);

    fireEvent.click(screen.getByRole('button', { name: '成功一' }));
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
