import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DebouncedSearchInput } from './DebouncedSearchInput';

afterEach(() => vi.useRealTimers());

it('debounces typing, commits Enter once and clears immediately', () => {
  vi.useFakeTimers();
  const onCommit = vi.fn();
  render(<DebouncedSearchInput aria-label="搜索" icon={null} onCommit={onCommit} value="" />);
  const input = screen.getByRole('searchbox');
  fireEvent.change(input, { target: { value: 'a' } });
  fireEvent.change(input, { target: { value: 'all' } });
  expect(input).toHaveValue('all');
  act(() => vi.advanceTimersByTime(249));
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  act(() => vi.advanceTimersByTime(300));
  expect(onCommit).toHaveBeenCalledExactlyOnceWith('all');
  fireEvent.change(input, { target: { value: '' } });
  expect(onCommit).toHaveBeenLastCalledWith('');
});

it('waits for IME completion and cancels a pending draft on navigation', () => {
  vi.useFakeTimers();
  const onCommit = vi.fn();
  const view = render(<DebouncedSearchInput icon={null} onCommit={onCommit} value="" resetKey="a" />);
  const input = screen.getByRole('searchbox');
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '知识' } });
  act(() => vi.advanceTimersByTime(500));
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  act(() => vi.advanceTimersByTime(250));
  expect(onCommit).toHaveBeenCalledExactlyOnceWith('知识');
  fireEvent.change(input, { target: { value: '未提交' } });
  view.rerender(<DebouncedSearchInput icon={null} onCommit={onCommit} value="历史" resetKey="b" />);
  act(() => vi.advanceTimersByTime(500));
  expect(input).toHaveValue('历史');
  expect(onCommit).toHaveBeenCalledTimes(1);
});
