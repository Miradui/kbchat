import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { tokenStore } from '../store/tokenStore';

export function ProtectedRoute() {
  const location = useLocation();
  const from = `${location.pathname}${location.search}${location.hash}`;
  return tokenStore.getToken()
    ? <Outlet />
    : <Navigate to="/login" replace state={{ from }} />;
}
