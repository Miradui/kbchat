import { useCallback, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AppShellFrame } from './AppShell';
import type { AppSection, Crumb } from './AppShell';
import { appShellContext } from './appShellContext';
import type { PageShellConfiguration } from './appShellContext';

// Keep the outlet element stable when a page publishes new toolbar controls.
const outlet = <Outlet />;

function normalizeNode(node: unknown) {
  return node === undefined || node === null || node === false ? null : node;
}

function sameBreadcrumbs(left?: Crumb[], right?: Crumb[]) {
  if (left === right) return true;
  const leftList = left ?? [];
  const rightList = right ?? [];
  if (leftList.length !== rightList.length) return false;
  return leftList.every((crumb, index) => (
    crumb.label === rightList[index].label && crumb.to === rightList[index].to
  ));
}

function sameShellConfiguration(left: PageShellConfiguration, right: PageShellConfiguration) {
  return left.active === right.active
    && Boolean(left.flush) === Boolean(right.flush)
    && Boolean(left.newChatDisabled) === Boolean(right.newChatDisabled)
    && Boolean(left.onNewChat) === Boolean(right.onNewChat)
    && Object.is(left.currentUserRequest, right.currentUserRequest)
    && Object.is(left.logoutRequest, right.logoutRequest)
    && Object.is(normalizeNode(left.topbarLeading), normalizeNode(right.topbarLeading))
    && Object.is(normalizeNode(left.topbarActions), normalizeNode(right.topbarActions))
    && sameBreadcrumbs(left.breadcrumbs, right.breadcrumbs);
}

/**
 * Only used while a page's chunk is still loading and has not registered yet.
 * Scoped documents live below a knowledge-base path but highlight the documents
 * entry, matching what the page reports once it mounts.
 */
function sectionForPath(path: string): AppSection {
  if (/^\/knowledge-bases\/[^/]+\/documents(?:\/|$)/.test(path)) return 'documents';
  if (path.startsWith('/knowledge-bases')) return 'knowledge-bases';
  if (path.startsWith('/admin/users')) return 'admin-users';
  return (['chat', 'documents', 'tags', 'quality', 'diagnostics', 'search'] as const)
    .find((section) => path === `/${section}` || path.startsWith(`/${section}/`)) ?? 'home';
}

/** The workspace frame stays mounted while only the route content suspends. */
export function WorkspaceLayout() {
  const location = useLocation();
  const [page, setPage] = useState<{ key: string; configuration: PageShellConfiguration } | null>(null);
  const onNewChatRef = useRef<(() => void) | undefined>(undefined);
  const handleNewChat = useCallback(() => onNewChatRef.current?.(), []);

  const sync = useCallback((key: string, configuration: PageShellConfiguration) => {
    onNewChatRef.current = configuration.onNewChat;
    setPage((current) => (
      current && current.key === key && sameShellConfiguration(current.configuration, configuration)
        ? current
        : { key, configuration }
    ));
  }, []);

  const unregister = useCallback((key: string) => {
    setPage((current) => (current?.key === key ? null : current));
  }, []);

  const registration = useMemo(() => ({ sync, unregister }), [sync, unregister]);
  const configuration = page?.key === location.key ? page.configuration : undefined;
  // The page knows its own section (documents below a knowledge base differ
  // from the path prefix); the path only fills the gap while it loads.
  const active = configuration?.active ?? sectionForPath(location.pathname);

  return <AppShellFrame {...configuration} active={active} onNewChat={configuration?.onNewChat ? handleNewChat : undefined}>
    <appShellContext.Provider value={registration}>{outlet}</appShellContext.Provider>
  </AppShellFrame>;
}
