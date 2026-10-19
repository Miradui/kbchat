import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCurrentUser, listChatSessions, logout } from '../api/resources';
import { currentUserStore } from '../store/currentUserStore';
import { tokenStore } from '../store/tokenStore';
import { renderWithRouter } from '../test/render';
import { AppShell, completeLogout, finishLocalLogout } from './AppShell';

vi.mock('../api/resources', () => ({
  getCurrentUser: vi.fn(),
  logout: vi.fn(),
  searchSuggest: vi.fn().mockResolvedValue({ items: [] }),
  listChatSessions: vi.fn(),
  listKnowledgeBases: vi.fn().mockResolvedValue({ items: [] }),
  updateChatSessionTitle: vi.fn(),
}));
const mockedGetCurrentUser = vi.mocked(getCurrentUser);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  currentUserStore.clear();
  mockedGetCurrentUser.mockReset().mockResolvedValue({
    id: 'user-1',
    username: 'admin',
    displayName: '管理员',
  });
  mockedLogout.mockReset().mockResolvedValue(undefined);
  vi.mocked(listChatSessions).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
});
afterEach(() => {
  document.body.style.overflow = '';
  vi.unstubAllGlobals();
});

describe('AppShell', () => {
  it('keeps history out of the primary navigation on workspace pages', async () => {
    stubMatchMedia(false);
    tokenStore.setToken('rail-account');
    const user = userEvent.setup();
    renderWithRouter(<Routes>
      <Route path="/home" element={<AppShell active="home"><p>首页内容</p></AppShell>} />
      <Route path="/documents" element={<AppShell active="documents"><p>文档内容</p></AppShell>} />
    </Routes>);
    await screen.findByRole('button', { name: '管理员' });
    expect(screen.queryByRole('complementary', { name: '会话列表' })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: '文档' }));
    expect(screen.getByText('文档内容')).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: '会话列表' })).not.toBeInTheDocument();
    expect(listChatSessions).not.toHaveBeenCalled();
  });

  it('keeps cached administrator navigation visible on the first render after a page change', async () => {
    stubMatchMedia(false);
    mockedGetCurrentUser.mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员', role: 'admin' });
    const first = renderWithRouter(<AppShell active="home"><p>内容</p></AppShell>);
    await screen.findByRole('link', { name: '系统诊断' });
    first.unmount();
    renderWithRouter(<AppShell active="documents"><p>文档内容</p></AppShell>);
    expect(screen.getByRole('link', { name: '系统诊断' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '用户管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '管理员' })).toBeInTheDocument();
    expect(mockedGetCurrentUser).toHaveBeenCalledOnce();
  });

  it('shows the authenticated user display name', async () => {
    stubMatchMedia(false);
    const currentUserRequest = vi.fn().mockResolvedValue({
      id: 'user-1',
      username: 'admin',
      displayName: '管理员',
    });

    renderWithRouter(<AppShell active="home" currentUserRequest={currentUserRequest}><p>内容</p></AppShell>);

    expect(await screen.findByText('管理员')).toBeInTheDocument();
    expect(currentUserRequest).toHaveBeenCalledOnce();
  });

  it('deduplicates the current-user request under StrictMode', async () => {
    stubMatchMedia(false);
    const currentUserRequest = vi.fn().mockResolvedValue({
      id: 'user-1',
      username: 'admin',
      displayName: '管理员',
    });

    renderWithRouter(
      <StrictMode>
        <AppShell active="home" currentUserRequest={currentUserRequest}><p>内容</p></AppShell>
      </StrictMode>,
    );

    expect(await screen.findByText('管理员')).toBeInTheDocument();
    expect(currentUserRequest).toHaveBeenCalledOnce();
  });

  it('reuses the current user when protected pages remount', async () => {
    stubMatchMedia(false);
    const currentUserRequest = vi.fn().mockResolvedValue({
      id: 'user-1',
      username: 'admin',
      displayName: '管理员',
    });

    const firstPage = renderWithRouter(
      <AppShell active="home" currentUserRequest={currentUserRequest}><p>首页</p></AppShell>,
    );
    expect(await screen.findByText('管理员')).toBeInTheDocument();
    firstPage.unmount();

    renderWithRouter(
      <AppShell active="documents" currentUserRequest={currentUserRequest}><p>文档</p></AppShell>,
      ['/documents'],
    );

    expect(await screen.findByText('管理员')).toBeInTheDocument();
    expect(currentUserRequest).toHaveBeenCalledOnce();
  });

  it('falls back to the username when display name is empty', async () => {
    stubMatchMedia(false);
    const currentUserRequest = vi.fn().mockResolvedValue({
      id: 'user-1',
      username: 'admin',
      displayName: '   ',
    });

    renderWithRouter(<AppShell active="home" currentUserRequest={currentUserRequest}><p>内容</p></AppShell>);

    expect(await screen.findByText('admin')).toBeInTheDocument();
  });

  it('reacts to mobile and desktop media changes', async () => {
    const media = stubMatchMedia(false);
    renderWithRouter(<AppShell active="home"><p>内容</p></AppShell>);
    expect(screen.queryByRole('button', { name: '打开导航' })).not.toBeInTheDocument();

    act(() => media.setMatches(true));
    const opener = screen.getByRole('button', { name: '打开导航' });
    await userEvent.click(opener);
    expect(screen.getByRole('navigation', { name: '主导航' }).closest('aside')).toHaveClass('is-open');

    act(() => media.setMatches(false));
    expect(screen.queryByRole('button', { name: '打开导航' })).not.toBeInTheDocument();
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
    const opener = screen.getByRole('button', { name: '打开导航' });
    await user.click(opener);

    expect(screen.getByRole('button', { name: '关闭导航' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    const applicationMain = opener.closest('.app__main');
    expect(applicationMain).toHaveAttribute('inert');
    expect(applicationMain).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('main', { hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /搜索/ , hidden: true }).closest('.app__main')).toBe(applicationMain);

    const first = screen.getByRole('link', { name: '知汇首页' });
    const last = screen.getByRole('button', { name: '管理员' });
    last.focus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('');
    expect(opener).toHaveFocus();
    expect(applicationMain).not.toHaveAttribute('inert');
    expect(applicationMain).not.toHaveAttribute('aria-hidden');
  });

  it('closes the drawer after navigation', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderWithRouter(<><AppShell active="home"><p>内容</p></AppShell><LocationProbe /></>);
    await user.click(screen.getByRole('button', { name: '打开导航' }));
    await user.click(screen.getByRole('link', { name: '知识库' }));

    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/knowledge-bases');
    expect(screen.getByRole('navigation', { name: '主导航', hidden: true }).closest('aside')).not.toHaveClass('is-open');
    expect(document.body.style.overflow).toBe('');
  });

  it('closes the mobile drawer with its close control', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderWithRouter(<AppShell active="knowledge-bases"><p>内容</p></AppShell>);

    await user.click(screen.getByRole('button', { name: '打开导航' }));
    await user.click(screen.getByRole('button', { name: '关闭导航' }));
    expect(screen.getByRole('navigation', { name: '主导航', hidden: true }).closest('aside')).not.toHaveClass('is-open');
    expect(screen.getByRole('button', { name: '打开导航' })).toHaveFocus();
  });

  it('shows the saved avatar and falls back when the image cannot load', async () => {
    stubMatchMedia(false);
    const currentUserRequest = vi.fn().mockResolvedValue({
      id: 'user-1',
      username: 'admin',
      displayName: '管理员',
      avatarUrl: 'https://example.com/avatar.png',
    });

    const view = renderWithRouter(
      <AppShell active="home" currentUserRequest={currentUserRequest}><p>内容</p></AppShell>,
    );

    await screen.findByText('管理员');
    const avatar = view.container.querySelector<HTMLImageElement>('.rail__user .ui-avatar img');
    expect(avatar).not.toBeNull();
    expect(avatar).toHaveAttribute('src', 'https://example.com/avatar.png');

    fireEvent.error(avatar!);
    expect(view.container.querySelector('.rail__user .ui-avatar img')).not.toBeInTheDocument();
  });

  it('keeps the mobile drawer open while focus moves within navigation', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderWithRouter(<AppShell active="knowledge-bases"><p>内容</p></AppShell>);

    await user.click(screen.getByRole('button', { name: '打开导航' }));
    await user.tab();
    expect(screen.getByRole('navigation', { name: '主导航' }).closest('aside')).toHaveClass('is-open');
  });

  it('encodes global search and ignores an empty submission', async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    renderWithRouter(<><AppShell active="home"><p>内容</p></AppShell><LocationProbe /></>);
    await user.click(screen.getByRole('button', { name: '搜索知识库、文档和内容' }));
    const input = screen.getByRole('textbox', { name: '搜索知识库、文档和内容' });

    await user.type(input, ' handbook & 中文 ');
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=handbook%20%26%20%E4%B8%AD%E6%96%87');

    await user.click(screen.getByRole('button', { name: '搜索知识库、文档和内容' }));
    const emptyInput = screen.getByRole('textbox', { name: '搜索知识库、文档和内容' });
    await user.type(emptyInput, '   ');
    await user.keyboard('{Escape}');
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

    await user.click(await screen.findByRole('button', { name: '管理员' }));
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
    await waitFor(() => expect(tokenStore.getToken()).toBeNull());
    await waitFor(() => expect(screen.getByLabelText('当前位置')).toHaveTextContent('/login'));
  });

  it('finishes local logout without writing component state after unmount', () => {
    tokenStore.setToken('token');
    const setLoggingOut = vi.fn();
    const navigate = vi.fn();

    finishLocalLogout(false, setLoggingOut, navigate);

    expect(setLoggingOut).not.toHaveBeenCalled();
    expect(tokenStore.getToken()).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('still clears the local token when a pending logout finishes after unmount', async () => {
    stubMatchMedia(false);
    tokenStore.setToken('token');
    const result = deferred<void>();
    const { unmount } = renderWithRouter(
      <AppShell active="home" logoutRequest={() => result.promise}><p>内容</p></AppShell>,
    );

    await userEvent.click(await screen.findByRole('button', { name: '管理员' }));
    const logoutButton = screen.getByRole('menuitem', { name: '退出登录' });
    fireEvent.click(logoutButton);
    unmount();
    await act(async () => result.resolve());

    expect(tokenStore.getToken()).toBeNull();
  });

  it('synchronously rejects repeated logout attempts', async () => {
    stubMatchMedia(false);
    const result = deferred<void>();
    const request = vi.fn(() => result.promise);
    renderWithRouter(<AppShell active="home" logoutRequest={request}><p>内容</p></AppShell>);
    await userEvent.click(await screen.findByRole('button', { name: '管理员' }));
    const button = screen.getByRole('menuitem', { name: '退出登录' });

    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(request).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menuitem', { name: '退出登录' })).not.toBeInTheDocument();
    result.resolve();
  });
});
