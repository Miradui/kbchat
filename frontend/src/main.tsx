import { StrictMode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './store/queryClient';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { ToastProvider } from './components/feedback/ToastProvider';
import { router } from './router';
import { themeStore } from './store/themeStore';
import './styles/index.css';

// Applied before the first paint so a dark preference does not flash light.
themeStore.init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
