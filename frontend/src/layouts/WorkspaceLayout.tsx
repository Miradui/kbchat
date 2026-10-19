import { useCallback, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AppShellFrame } from './AppShell';
import type { AppSection } from './AppShell';
import { appShellContext } from './appShellContext';
import type { PageShellConfiguration } from './appShellContext';

// Keep the outlet element stable when a page publishes new toolbar controls.
const outlet = <Outlet />;

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
  const register = useCallback((key: string, configuration: PageShellConfiguration) => {
    const entry = { key, configuration };
    setPage(entry);
    return () => setPage((current) => current === entry ? null : current);
  }, []);
  const configuration = page?.key === location.key ? page.configuration : undefined;
  // The page knows its own section (documents below a knowledge base differ
  // from the path prefix); the path only fills the gap while it loads.
  const active = configuration?.active ?? sectionForPath(location.pathname);

  return <AppShellFrame {...configuration} active={active}>
    <appShellContext.Provider value={register}>{outlet}</appShellContext.Provider>
  </AppShellFrame>;
}
