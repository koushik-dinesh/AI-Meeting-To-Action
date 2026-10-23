import { Navigate, Outlet, useLocation } from 'react-router';
import { homePathFor, useAuth } from './AuthContext.jsx';

// Client-side guard for UX only; the API enforces authentication and roles itself.
export function ProtectedRoute({ roles }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-slate-500">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to={homePathFor(user)} replace />;
  }
  return <Outlet />;
}
