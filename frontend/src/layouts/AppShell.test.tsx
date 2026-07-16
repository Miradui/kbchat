import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logout } from '../api/resources';
import { tokenStore } from '../store/tokenStore';
import { renderWithRouter } from '../test/render';
import { AppShell, completeLogout } from './AppShell';

vi.mock('../api/resources', () => ({ logout: vi.fn() }));
const mockedLogout = vi.mocked(logout);

function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() { return matches; },
    media: '(max-width: 980px)',
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
    removeEventListener: media.removeEventListener,
    setMatches(value: boolean) {
      matches = value;
      const event = { matches: value, media: media.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname + location.search}</output>;
}

beforeEach(() => mockedLogout.mockReset().mockResolvedValue(undefined));
afterEach(() => {
  document.body.style.overflow = '';
  vi.unstubAllGlobals();
});

describe('AppShell', () => {
  it('reacts to mobile and desktop media changes', async () => {
    const media = stubMatchMedia(false);
    renderWithRouter(<AppShell active="home"><p>内容</p></AppShell>);
    expect(screen.queryByRole('button', { name: '打开主导航' })).not.toBeInTheDocument();

    act(() => media.setMatches(true));
    const opener = screen.getByRole('button', { name: '打开主导航' });
    await userEvent.click(opener);
    expect(screen.getByRole('navigation', { name: '主导航' }).closest('aside')).toHaveClass('is-open');

    act(() => media.setMatches(false));
    expect(screen.queryByRole('button', { name: '打开主导航' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '主导航' }).closest('aside')).not.toHaveClass('is-open');
  });

  it('removes the media listener on unmount', () => {
    const media = stubMatchMedia(false);
    const { unmount } = renderWithRouter(<AppShell active="home"><p>内容</p></AppShell>);
    unmount();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('constrains drawer focus, locks scroll, and restores the opener', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderWithRouter(<AppShell active="home"><button type="button">背景操作</button></AppShell>);
    const opener = screen.getByRole('button', { name: '打开主导航' });
    await user.click(opener);

    expect(screen.getByRole('button', { name: '关闭主导航' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('main')).toHaveAttribute('inert');

    const first = screen.getByRole('link', { name: 'RAG Console' });
    const last = screen.getByRole('link', { name: '标签管理' });
    last.focus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('');
    expect(opener).toHaveFocus();
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
  });

  it('closes the drawer after navigation', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderWithRouter(<><AppShell active="home"><p>内容</p></AppShell><LocationProbe /></>);
    await user.click(screen.getByRole('button', { name: '打开主导航' }));
    await user.click(screen.getByRole('link', { name: '知识库' }));

    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/knowledge-bases');
    expect(screen.getByRole('navigation', { name: '主导航', hidden: true }).closest('aside')).not.toHaveClass('is-open');
    expect(document.body.style.overflow).toBe('');
  });

  it('encodes global search and ignores an empty submission', async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    renderWithRouter(<><AppShell active="home"><p>内容</p></AppShell><LocationProbe /></>);
    const input = screen.getByRole('textbox', { name: '全局搜索' });

    await user.type(input, ' handbook & 中文 ');
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=handbook%20%26%20%E4%B8%AD%E6%96%87');

    await user.clear(input);
    await user.type(input, '   ');
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=handbook%20%26%20%E4%B8%AD%E6%96%87');
  });

  it('finishes local logout when the remote request fails', async () => {
    const finish = vi.fn();
    await completeLogout(() => Promise.reject(new Error('offline')), finish);
    expect(finish).toHaveBeenCalledOnce();
  });

  it('clears the local token and navigates when UI logout fails remotely', async () => {
    stubMatchMedia(false);
    tokenStore.setToken('token');
    const user = userEvent.setup();
    renderWithRouter(<><AppShell active="home" logoutRequest={() => Promise.reject(new Error('offline'))}><p>内容</p></AppShell><LocationProbe /></>);

    await user.click(screen.getByRole('button', { name: '退出登录' }));
    await waitFor(() => expect(tokenStore.getToken()).toBeNull());
    await waitFor(() => expect(screen.getByLabelText('当前位置')).toHaveTextContent('/login'));
  });
});
