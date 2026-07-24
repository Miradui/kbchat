import { Command, LogOut, Menu, Search, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { logout } from '../api/resources';
import { PrimaryNav } from '../components/navigation/PrimaryNav';
import type { AppSection } from '../components/navigation/PrimaryNav';
import { IconButton } from '../components/ui/IconButton';
import { tokenStore } from '../store/tokenStore';

export type { AppSection } from '../components/navigation/PrimaryNav';

export type AppShellProps = {
  active: AppSection;
  contextSidebar?: ReactNode;
  topbarContent?: ReactNode;
  logoutRequest?: () => Promise<void>;
  children: ReactNode;
};

function mediaMatches(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.matches(':disabled') && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
}

const sectionLabels: Record<AppSection, string> = {
  home: '首页', 'knowledge-bases': '知识库', documents: '文档管理', chat: '问答管理', search: '全局搜索', tags: '标签管理',
};

export async function completeLogout(request: () => Promise<void>, finish: () => void): Promise<void> {
  try { await request(); } catch { /* Local logout must still finish. */ }
  finally { finish(); }
}

export function AppShell({ active, contextSidebar, topbarContent, logoutRequest = logout, children }: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => mediaMatches('(max-width: 980px)'));
  const [searchDraft, setSearchDraft] = useState('');
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 980px)');
    const update = () => setIsMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => setDrawerOpen(false), [location.pathname, location.search]);
  useEffect(() => { if (!isMobile) setDrawerOpen(false); }, [isMobile]);
  useEffect(() => {
    if (!isMobile) { drawerWasOpen.current = false; return; }
    if (drawerOpen) { drawerWasOpen.current = true; closeButtonRef.current?.focus(); }
    else if (drawerWasOpen.current) { drawerWasOpen.current = false; menuButtonRef.current?.focus(); }
  }, [drawerOpen, isMobile]);

  useEffect(() => {
    if (!isMobile || !drawerOpen) return;
    const sidebar = sidebarRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); setDrawerOpen(false); return; }
      if (event.key !== 'Tab' || !sidebar) return;
      const controls = getFocusable(sidebar);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); document.body.style.overflow = previousOverflow; };
  }, [drawerOpen, isMobile]);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchDraft.trim();
    if (query) navigate(`/search?q=${encodeURIComponent(query)}`);
  }

  function handleLogout() {
    const finish = () => { tokenStore.clearToken(); navigate('/login', { replace: true }); };
    void completeLogout(logoutRequest, finish);
  }

  const drawerHidden = isMobile && !drawerOpen;
  return (
    <section className="app-layout" data-active={active}>
      <aside aria-hidden={drawerHidden || undefined} className={drawerOpen ? 'app-sidebar is-open' : 'app-sidebar'} inert={drawerHidden || undefined} ref={sidebarRef}>
        <div className="app-sidebar__brand-row">
          <Link aria-label="RAG Console" className="app-brand" to="/home" onClick={() => setDrawerOpen(false)}>
            <span className="app-brand__mark" aria-hidden="true"><Command /></span>
            <span className="app-brand__copy"><strong>RAG Console</strong><small>Knowledge workspace</small></span>
          </Link>
          {isMobile && <IconButton ref={closeButtonRef} className="app-drawer-close" label="关闭主导航" onClick={() => setDrawerOpen(false)}><X aria-hidden="true" /></IconButton>}
        </div>
        <PrimaryNav active={active} onNavigate={() => setDrawerOpen(false)} />
        {contextSidebar && <div className="app-context-sidebar">{contextSidebar}</div>}
      </aside>
      {isMobile && drawerOpen && <button aria-hidden="true" className="app-drawer-backdrop" onClick={() => setDrawerOpen(false)} tabIndex={-1} type="button" />}
      <div className="app-main">
        <header className="app-topbar">
          {isMobile && <IconButton ref={menuButtonRef} className="app-menu-button" label="打开主导航" onClick={() => setDrawerOpen(true)}><Menu aria-hidden="true" /></IconButton>}
          <div className="app-topbar__context">{topbarContent ?? sectionLabels[active]}</div>
          <form className="app-global-search" onSubmit={handleSearch}>
            <Search aria-hidden="true" /><label className="sr-only" htmlFor="app-global-search">全局搜索</label>
            <input id="app-global-search" placeholder="搜索知识库、文档和内容" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
          </form>
          <div className="app-account-actions" aria-label="账户操作"><span className="app-user-badge" aria-hidden="true"><UserRound /></span><span>当前用户</span><IconButton label="退出登录" onClick={handleLogout}><LogOut aria-hidden="true" /></IconButton></div>
        </header>
        <main className="app-content" inert={(isMobile && drawerOpen) || undefined}>{children}</main>
      </div>
    </section>
  );
}
