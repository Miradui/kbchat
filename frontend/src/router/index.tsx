import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';

import { App } from '../App';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { ProtectedRoute } from './ProtectedRoute';

const LoginPage = lazy(() => import('../pages/Login/LoginPage').then((module) => ({ default: module.LoginPage })));
const HomePage = lazy(() => import('../pages/Home/HomePage').then((module) => ({ default: module.HomePage })));
const KnowledgeBaseListPage = lazy(() => import('../pages/KnowledgeBase/KnowledgeBaseListPage').then((module) => ({ default: module.KnowledgeBaseListPage })));
const KnowledgeBaseDetailPage = lazy(() => import('../pages/KnowledgeBase/KnowledgeBaseDetailPage').then((module) => ({ default: module.KnowledgeBaseDetailPage })));
const DocumentsLandingPage = lazy(() => import('../pages/Documents/DocumentsLandingPage').then((module) => ({ default: module.DocumentsLandingPage })));
const DocumentsPage = lazy(() => import('../pages/Documents/DocumentsPage').then((module) => ({ default: module.DocumentsPage })));
const ChatLandingPage = lazy(() => import('../pages/Chat/ChatLandingPage').then((module) => ({ default: module.ChatLandingPage })));
const ChatPage = lazy(() => import('../pages/Chat/ChatPage').then((module) => ({ default: module.ChatPage })));
const SearchPage = lazy(() => import('../pages/Search/SearchPage').then((module) => ({ default: module.SearchPage })));
const TagsPage = lazy(() => import('../pages/Tags/TagsPage').then((module) => ({ default: module.TagsPage })));

function RoutePage({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="route-loading"><LoadingSkeleton announce rows={5} columns={3} /></div>}>
      {children}
    </Suspense>
  );
}

export const router = createBrowserRouter([{
  path: '/',
  element: <App />,
  children: [
    { index: true, element: <Navigate to="/home" replace /> },
    { path: 'login', element: <RoutePage><LoginPage /></RoutePage> },
    {
      element: <ProtectedRoute />,
      children: [
        { path: 'home', element: <RoutePage><HomePage /></RoutePage> },
        { path: 'knowledge-bases', element: <RoutePage><KnowledgeBaseListPage /></RoutePage> },
        { path: 'knowledge-bases/:id', element: <RoutePage><KnowledgeBaseDetailPage /></RoutePage> },
        { path: 'knowledge-bases/:id/documents', element: <RoutePage><DocumentsPage /></RoutePage> },
        { path: 'documents', element: <RoutePage><DocumentsLandingPage /></RoutePage> },
        { path: 'chat', element: <RoutePage><ChatLandingPage /></RoutePage> },
        { path: 'chat/new', element: <RoutePage><ChatPage draftSession /></RoutePage> },
        { path: 'chat/:sessionId', element: <RoutePage><ChatPage /></RoutePage> },
        { path: 'search', element: <RoutePage><SearchPage /></RoutePage> },
        { path: 'tags', element: <RoutePage><TagsPage /></RoutePage> },
      ],
    },
    { path: '*', element: <Navigate to="/home" replace /> },
  ],
}]);
