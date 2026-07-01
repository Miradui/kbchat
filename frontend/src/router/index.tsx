import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';

import { App } from '../App';
import { tokenStore } from '../store/tokenStore';
import { ChatLandingPage } from '../pages/Chat/ChatLandingPage';
import { ChatPage } from '../pages/Chat/ChatPage';
import { DocumentsLandingPage } from '../pages/Documents/DocumentsLandingPage';
import { DocumentsPage } from '../pages/Documents/DocumentsPage';
import { HomePage } from '../pages/Home/HomePage';
import { KnowledgeBaseDetailPage } from '../pages/KnowledgeBase/KnowledgeBaseDetailPage';
import { KnowledgeBaseListPage } from '../pages/KnowledgeBase/KnowledgeBaseListPage';
import { LoginPage } from '../pages/Login/LoginPage';
import { SearchPage } from '../pages/Search/SearchPage';
import { TagsPage } from '../pages/Tags/TagsPage';

function ProtectedRoute() {
  if (!tokenStore.getToken()) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        index: true,
        element: <Navigate to="/home" replace />,
      },
      {
        path: 'login',
        element: <LoginPage />,
      },
      {
        element: <ProtectedRoute />,
        children: [
          {
            path: 'home',
            element: <HomePage />,
          },
          {
            path: 'knowledge-bases',
            element: <KnowledgeBaseListPage />,
          },
          {
            path: 'knowledge-bases/:id',
            element: <KnowledgeBaseDetailPage />,
          },
          {
            path: 'knowledge-bases/:id/documents',
            element: <DocumentsPage />,
          },
          {
            path: 'documents',
            element: <DocumentsLandingPage />,
          },
          {
            path: 'chat',
            element: <ChatLandingPage />,
          },
          {
            path: 'chat/:sessionId',
            element: <ChatPage />,
          },
          {
            path: 'search',
            element: <SearchPage />,
          },
          {
            path: 'tags',
            element: <TagsPage />,
          },
        ],
      },
      {
        path: '*',
        element: <Navigate to="/home" replace />,
      },
    ],
  },
]);
