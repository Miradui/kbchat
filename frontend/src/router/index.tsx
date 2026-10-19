import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';

import { App } from '../App';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { ProtectedRoute } from './ProtectedRoute';
import { RenderBoundary, RenderFailure } from '../components/feedback/RenderBoundary';
import { WorkspaceLayout } from '../layouts/WorkspaceLayout';

const LoginPage = lazy(() => import('../pages/Login/LoginPage').then((m) => ({ default: m.LoginPage })));
const HomePage = lazy(() => import('../pages/Home/HomePage').then((m) => ({ default: m.HomePage })));
const KnowledgeBaseListPage = lazy(() => import('../pages/KnowledgeBase/KnowledgeBaseListPage').then((m) => ({ default: m.KnowledgeBaseListPage })));
const KnowledgeBaseOverviewPage = lazy(() => import('../pages/KnowledgeBase/KnowledgeBaseOverviewPage').then((m) => ({ default: m.KnowledgeBaseOverviewPage })));
const KnowledgeBaseSettingsPage = lazy(() => import('../pages/KnowledgeBase/KnowledgeBaseSettingsPage').then((m) => ({ default: m.KnowledgeBaseSettingsPage })));
const DocumentsPage = lazy(() => import('../pages/Documents/DocumentsPage').then((m) => ({ default: m.DocumentsPage })));
const ChatPage = lazy(() => import('../pages/Chat/ChatPage').then((m) => ({ default: m.ChatPage })));
const SearchPage = lazy(() => import('../pages/Search/SearchPage').then((m) => ({ default: m.SearchPage })));
const TagsPage = lazy(() => import('../pages/Tags/TagsPage').then((m) => ({ default: m.TagsPage })));
const QualityPage = lazy(() => import('../pages/Quality/QualityPage').then((m) => ({ default: m.QualityPage })));
const DiagnosticsPage = lazy(() => import('../pages/Diagnostics/DiagnosticsPage').then((m) => ({ default: m.DiagnosticsPage })));
const AdminUsersPage = lazy(() => import('../pages/Admin/UsersPage').then((m) => ({ default: m.UsersPage })));

function RoutePage({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <RenderBoundary resetKey={location.pathname}>
      <Suspense fallback={<div className="route-loading"><LoadingSkeleton announce rows={5} columns={3} /></div>}>
        {children}
      </Suspense>
    </RenderBoundary>
  );
}

/**
 * `/chat/new?knowledgeBaseId=X` was the draft route. `/chat` is now the draft
 * state itself, so the old link is preserved as a redirect that keeps the query.
 */
function LegacyChatDraftRedirect() {
  const [searchParams] = useSearchParams();
  const query = searchParams.toString();
  return <Navigate replace to={query ? `/chat?${query}` : '/chat'} />;
}

/**
 * The detail page used `?tab=overview|qa|settings`, while documents lived at a
 * sub-path. All four are sub-paths now; the old query values still resolve.
 */
function KnowledgeBaseDetailEntry() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  const encodedId = encodeURIComponent(id ?? '');

  if (tab === 'settings') {
    return <Navigate replace to={`/knowledge-bases/${encodedId}/settings`} />;
  }
  if (tab === 'qa') {
    return <Navigate replace to={`/chat?knowledgeBaseId=${encodedId}`} />;
  }
  if (tab === 'overview') {
    return <Navigate replace to={`/knowledge-bases/${encodedId}`} />;
  }
  return <RoutePage><KnowledgeBaseOverviewPage /></RoutePage>;
}

export const router = createBrowserRouter([{
  path: '/',
  element: <App />,
  errorElement: <RenderFailure />,
  children: [
    { index: true, element: <Navigate to="/home" replace /> },
    { path: 'login', element: <RoutePage><LoginPage /></RoutePage> },
    {
      element: <ProtectedRoute />,
      children: [
        { element: <WorkspaceLayout />, children: [
        { path: 'home', element: <RoutePage><HomePage /></RoutePage> },

        { path: 'knowledge-bases', element: <RoutePage><KnowledgeBaseListPage /></RoutePage> },
        { path: 'knowledge-bases/:id', element: <KnowledgeBaseDetailEntry /> },
        {
          path: 'knowledge-bases/:id/documents',
          element: <RoutePage><DocumentsPage scoped /></RoutePage>,
        },
        {
          path: 'knowledge-bases/:id/settings',
          element: <RoutePage><KnowledgeBaseSettingsPage /></RoutePage>,
        },

        { path: 'documents', element: <RoutePage><DocumentsPage /></RoutePage> },

        { path: 'chat', element: <RoutePage><ChatPage /></RoutePage> },
        { path: 'chat/new', element: <LegacyChatDraftRedirect /> },
        { path: 'chat/:sessionId', element: <RoutePage><ChatPage /></RoutePage> },
		{ path: 'quality', element: <RoutePage><QualityPage /></RoutePage> },
		{ path: 'diagnostics', element: <RoutePage><DiagnosticsPage /></RoutePage> },
		{ path: 'admin/users', element: <RoutePage><AdminUsersPage /></RoutePage> },

        { path: 'search', element: <RoutePage><SearchPage /></RoutePage> },
        { path: 'tags', element: <RoutePage><TagsPage /></RoutePage> },
        ] },
      ],
    },
    { path: '*', element: <Navigate to="/home" replace /> },
  ],
}]);
