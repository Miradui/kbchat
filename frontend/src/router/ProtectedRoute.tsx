import { Navigate, Outlet } from 'react-router-dom';

import { tokenStore } from '../store/tokenStore';

export function ProtectedRoute() {
  return tokenStore.getToken() ? <Outlet /> : <Navigate to="/login" replace />;
}
