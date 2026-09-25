import { afterEach, expect, it, vi } from 'vitest';
import { createStreamText } from './streamText';
afterEach(() => vi.useRealTimers());

it('publishes first text immediately, batches following deltas and clears queued text on switch', () => {
  vi.useFakeTimers();
  const store = createStreamText();
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  store.set('一');
  store.set('一二');
  store.set('一二三');
  expect(store.getSnapshot()).toBe('一');
  vi.advanceTimersByTime(50);
  expect(store.getSnapshot()).toBe('一二三');
  expect(listener).toHaveBeenCalledTimes(2);
  store.set('旧会话');
  store.set('');
  vi.advanceTimersByTime(100);
  expect(store.getSnapshot()).toBe('');
  unsubscribe(); store.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('flushes pending text on visibility changes and disposal cancels publication', () => {
  vi.useFakeTimers();
  const store = createStreamText();
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  store.set('a'); store.set('abc');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(store.getSnapshot()).toBe('abc');
  store.set('stale'); store.dispose();
  vi.advanceTimersByTime(100);
  expect(store.getSnapshot()).toBe('abc');
  unsubscribe();
});
