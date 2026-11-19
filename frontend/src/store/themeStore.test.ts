import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_THEME_ACCENT, themeStore } from './themeStore';

function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() { return matches; },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.delete(listener);
    }),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  return {
    setMatches(value: boolean) {
      matches = value;
      const event = { matches: value, media: media.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

describe('themeStore', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#fbfcfe" />';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-accent');
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-accent');
  });

  it('defaults to system appearance and slate-blue accent without setting attributes', () => {
    stubMatchMedia(false);
    themeStore.init();

    expect(themeStore.get()).toBe('system');
    expect(themeStore.getAccent()).toBe(DEFAULT_THEME_ACCENT);
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(document.documentElement).not.toHaveAttribute('data-accent');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#fbfcfe');
  });

  it('persists accent changes, updates data-accent and theme-color, and notifies subscribers', () => {
    stubMatchMedia(false);
    themeStore.init();
    const listener = vi.fn();
    const unsubscribe = themeStore.subscribeAccent(listener);

    themeStore.setAccent('terracotta');
    expect(themeStore.getAccent()).toBe('terracotta');
    expect(window.localStorage.getItem('rag.theme.accent')).toBe('terracotta');
    expect(document.documentElement).toHaveAttribute('data-accent', 'terracotta');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#fcfaf7');
    expect(listener).toHaveBeenCalledWith('terracotta');

    themeStore.set('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#1a1614');

    themeStore.setAccent('slate-blue');
    expect(document.documentElement).not.toHaveAttribute('data-accent');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#13181f');

    unsubscribe();
  });

  it('restores valid persisted preferences and ignores invalid storage values', () => {
    stubMatchMedia(false);
    window.localStorage.setItem('rag.theme', 'dark');
    window.localStorage.setItem('rag.theme.accent', 'indigo');
    themeStore.init();

    expect(themeStore.get()).toBe('dark');
    expect(themeStore.getAccent()).toBe('indigo');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-accent', 'indigo');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#14161f');

    window.localStorage.setItem('rag.theme', 'bogus');
    window.localStorage.setItem('rag.theme.accent', 'bogus');
    themeStore.init();

    expect(themeStore.get()).toBe('system');
    expect(themeStore.getAccent()).toBe('slate-blue');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(document.documentElement).not.toHaveAttribute('data-accent');
  });

  it('tracks system color-scheme changes with the active accent palette', () => {
    const media = stubMatchMedia(false);
    themeStore.init();
    themeStore.setAccent('sage-green');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#fcfcfa');

    media.setMatches(true);
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#161b19');

    media.setMatches(false);
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#fcfcfa');
  });
});
