import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RetryCountdown } from './RetryCountdown';

afterEach(() => vi.useRealTimers());

it('uses the deadline after a clock jump and stops announcing an expired wait', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const view = render(<RetryCountdown notice={{ expiresAt: 60000, message: '' }} />);
  expect(screen.getByText('请求过于频繁，请 60 秒后再试')).toHaveAttribute('aria-live', 'off');
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText('请求过于频繁，请 59 秒后再试')).toBeInTheDocument();
  act(() => {
    vi.setSystemTime(65000);
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(screen.getByText('等待已结束，可以重试。')).toBeInTheDocument();
  view.rerender(<RetryCountdown notice={{ expiresAt: null, message: '' }} />);
  expect(screen.getByText('请求过于频繁，请稍后再试')).toBeInTheDocument();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
