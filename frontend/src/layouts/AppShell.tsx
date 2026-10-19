import { ChevronsUpDown, LogOut, Menu, Monitor, Moon, Search, Settings, Sun, X } from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';

import { getCurrentUser, logout } from '../api/resources';
import { BrandMark } from '../components/BrandMark';
import { UserAvatar } from '../components/UserAvatar';
import { CommandPalette } from '../components/CommandPalette';
import { PrimaryNav } from '../components/navigation/PrimaryNav';
import type { AppSection } from '../components/navigation/PrimaryNav';
import { IconButton } from '../components/ui/IconButton';
import { Popover } from '../components/ui/Popover';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { currentUserStore } from '../store/currentUserStore';
import { themeStore } from '../store/themeStore';
import type { ThemeChoice } from '../store/themeStore';
import { tokenStore } from '../store/tokenStore';
import { AccountSettingsDialog } from './AccountSettingsDialog';
import { UploadTasksButton } from '../pages/Documents/UploadTasksButton';
import { appShellContext } from './appShellContext';

export type { AppSection } from '../components/navigation/PrimaryNav';

export type Crumb = { label: string; to?: string };

export type AppShellProps = {
  active: AppSection;
  /** Navigation context rendered in the topbar. */
  breadcrumbs?: Crumb[];
  /** Page-level actions rendered at the right of the topbar. */
  topbarActions?: ReactNode;
  /** Removes content padding, for full-height pages such as chat. */
  flush?: boolean;
  /** Page-specific controls before the topbar breadcrumbs. */
  topbarLeading?: ReactNode;
  onNewChat?: () => void;
  newChatDisabled?: boolean;
  currentUserRequest?: typeof getCurrentUser;
  logoutRequest?: () => Promise<void>;
  children: ReactNode;
};

const sectionLabels: Record<AppSection, string> = {
  home: '首页',
  chat: 'AI 问答',
  quality: '质量运营',
  diagnostics: '系统诊断',
  'knowledge-bases': '知识库',
  documents: '文档',
  tags: '标签',
  search: '搜索',
  'admin-users': '用户管理',
};

const themeOptions: Array<{ value: ThemeChoice; label: string; icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
];

export async function completeLogout(request: () => Promise<void>, finish: () => void): Promise<void> {
  try {
    await request();
  } catch {
    // A failed server logout must not strand the user in an authenticated shell.
  } finally {
    finish();
  }
}

export function finishLocalLogout(
  mounted: boolean,
  setLoggingOut: (loggingOut: boolean) => void,
  navigate: NavigateFunction,
): void {
  if (mounted) setLoggingOut(false);
  tokenStore.clearToken();
  currentUserStore.clear();
  navigate('/login', { replace: true });
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.matches(':disabled') && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
}

export function AppShell(props: AppShellProps) {
  const register = useContext(appShellContext);
  const location = useLocation();
  useLayoutEffect(() => {
    if (!register) return;
    const { children: _children, ...configuration } = props;
    return register(location.key, configuration);
  }, [register, location.key, props]);
  return register ? props.children : <AppShellFrame {...props} />;
}

export function AppShellFrame({
  active,
  breadcrumbs,
  topbarActions,
  flush = false,
  topbarLeading,
  onNewChat,
  newChatDisabled,
  currentUserRequest = getCurrentUser,
  logoutRequest = logout,
  children,
}: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user: currentUser } = useCurrentUser(currentUserRequest);
  const isMobile = useMediaQuery('(max-width: 980px)');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [userName, setUserName] = useState(() => currentUser ? currentUser.displayName.trim() || currentUser.username : '当前用户');
  const [userAvatarUrl, setUserAvatarUrl] = useState(() => currentUser?.avatarUrl?.trim() ?? '');
  const [theme, setTheme] = useState<ThemeChoice>(() => themeStore.get());
  const [loggingOut, setLoggingOut] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  const logoutPendingRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => themeStore.subscribe(setTheme), []);

  useEffect(() => setDrawerOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  useEffect(() => {
    setUserName(currentUser ? currentUser.displayName.trim() || currentUser.username : '当前用户');
    setUserAvatarUrl(currentUser?.avatarUrl?.trim() ?? '');
  }, [currentUser]);

  // Global palette shortcut.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isPaletteKey = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (!isPaletteKey) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Mobile drawer focus handling.
  useEffect(() => {
    if (!isMobile) {
      drawerWasOpen.current = false;
      return;
    }
    if (drawerOpen) {
      drawerWasOpen.current = true;
      closeButtonRef.current?.focus();
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      if (!document.querySelector('[aria-modal="true"]')) menuButtonRef.current?.focus();
    }
  }, [drawerOpen, isMobile]);

  useEffect(() => {
    if (!isMobile || !drawerOpen) return;
    const rail = railRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !rail) return;
      const controls = getFocusable(rail);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen, isMobile]);

  const handleLogout = useCallback(() => {
    if (logoutPendingRef.current) return;
    logoutPendingRef.current = true;
    setLoggingOut(true);
    void completeLogout(logoutRequest, () => {
      logoutPendingRef.current = false;
      finishLocalLogout(mountedRef.current, setLoggingOut, navigate);
    });
  }, [logoutRequest, navigate]);

  const crumbs: Crumb[] = breadcrumbs && breadcrumbs.length > 0
    ? breadcrumbs
    : [{ label: sectionLabels[active] }];
  const railHidden = isMobile && !drawerOpen;
  const shortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';

  return (
    <div className="app">
      <a className="app__skip" href="#main-content">跳到主要内容</a>
      <aside
        aria-label="工作区导航"
        aria-hidden={railHidden || undefined}
        className={`rail${drawerOpen ? ' is-open' : ''}`}
        inert={railHidden || undefined}
        ref={railRef}
      >
        <div className="rail__brand-row">
          <Link aria-label="知汇首页" className="rail__brand" to="/home">
            <BrandMark className="rail__mark" />
            <span className="rail__brand-text">
              <strong className="rail__wordmark">知汇</strong>
              <small>知识管理 · 智能问答</small>
            </span>
          </Link>
          {isMobile && (
            <IconButton className="rail__close" label="关闭导航" onClick={() => setDrawerOpen(false)} ref={closeButtonRef}>
              <X aria-hidden="true" />
            </IconButton>
          )}
        </div>

        <PrimaryNav active={active} canViewDiagnostics={currentUser?.role === 'admin'} onNavigate={() => setDrawerOpen(false)} onNewChat={onNewChat} newChatDisabled={newChatDisabled} />

        <div className="rail__foot">
          <Popover
            align="start"
            label="账户菜单"
            width={200}
            trigger={(props) => (
              <button {...props} className="rail__user" type="button">
                <UserAvatar url={userAvatarUrl} name={userName} />
                <span className="rail__user-name" title={userName}>{userName}</span>
                <ChevronsUpDown aria-hidden="true" />
              </button>
            )}
          >
            {(close) => (
              <>
                <p className="ui-menu-label">主题</p>
                {themeOptions.map(({ value, label, icon: Icon }) => (
                  <button
                    aria-checked={theme === value}
                    className="ui-menu-item"
                    key={value}
                    onClick={() => themeStore.set(value)}
                    role="menuitemradio"
                    type="button"
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                    {theme === value && <span aria-hidden="true" style={{ marginLeft: 'auto' }}>✓</span>}
                  </button>
                ))}
                <div className="ui-menu-sep" />
                <button
                  className="ui-menu-item"
                  onClick={() => {
                    close();
                    setAccountOpen(true);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Settings aria-hidden="true" />
                  <span>账户设置</span>
                </button>
                <div className="ui-menu-sep" />
                <button
                  className="ui-menu-item"
                  disabled={loggingOut}
                  onClick={() => {
                    close();
                    handleLogout();
                  }}
                  role="menuitem"
                  type="button"
                >
                  <LogOut aria-hidden="true" />
                  <span>{loggingOut ? '退出中…' : '退出登录'}</span>
                </button>
              </>
            )}
          </Popover>
        </div>
      </aside>

      {isMobile && drawerOpen && (
        <button
          aria-hidden="true"
          className="app__scrim"
          onClick={() => setDrawerOpen(false)}
          tabIndex={-1}
          type="button"
        />
      )}

      <div
        aria-hidden={(isMobile && drawerOpen) || undefined}
        className="app__main"
        inert={(isMobile && drawerOpen) || undefined}
      >
        <header className="topbar">
          {isMobile && (
            <IconButton
              className="topbar__menu-button"
              data-modal-focus-fallback
              label="打开导航"
              onClick={() => setDrawerOpen(true)}
              ref={menuButtonRef}
            >
              <Menu aria-hidden="true" />
            </IconButton>
          )}

          {topbarLeading}
          <nav aria-label="面包屑" className="topbar__crumbs">
            {crumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} style={{ display: 'contents' }}>
                {index > 0 && <span aria-hidden="true" className="topbar__crumb-sep">›</span>}
                {crumb.to && index < crumbs.length - 1
                  ? <Link to={crumb.to}>{crumb.label}</Link>
                  : <span aria-current={index === crumbs.length - 1 ? 'page' : undefined}>{crumb.label}</span>}
              </span>
            ))}
          </nav>

          {/*
            Last-resort focus target when a modal closes and the element that opened it
            is gone -- deleting a row is the usual way that happens, since the confirm
            dialog was opened from a button inside the row being deleted. The mobile menu
            button above carries the same marker and wins on mobile by document order;
            this one is what makes the fallback exist on desktop at all, where that
            button is not rendered and focus was falling to `body`.
          */}
          <button
            aria-label="搜索知识库、文档和内容"
            className="topbar__search"
            data-modal-focus-fallback
            onClick={() => setPaletteOpen(true)}
            type="button"
          >
            <Search aria-hidden="true" />
            <span className="topbar__search-label">搜索知识库、文档…</span>
            <kbd className="topbar__kbd">{shortcutLabel}</kbd>
          </button>

          <UploadTasksButton />
          {topbarActions && <div className="topbar__actions">{topbarActions}</div>}
        </header>

        <main className={flush ? 'app__content app__content--flush' : 'app__content'} id="main-content" tabIndex={-1}>{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {/* Mounted on demand: the dialog reads /auth/me and /system/capabilities,
          and the shell should not pay for those until it is actually opened. */}
      {accountOpen && (
        <AccountSettingsDialog
          onClose={() => setAccountOpen(false)}
          onProfileSaved={(user) => {
            setUserName(user.displayName.trim() || user.username);
            setUserAvatarUrl(user.avatarUrl?.trim() ?? '');
          }}
          open
        />
      )}
    </div>
  );
}
