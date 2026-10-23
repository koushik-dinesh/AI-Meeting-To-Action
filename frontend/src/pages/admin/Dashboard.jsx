import { useAuth } from '../../auth/AuthContext.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';

export function AdminDashboard() {
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">Signed in as {user.email}</p>
      </div>
      <EmptyState title="No meetings yet">Meetings, action items, and email tracking arrive in later phases.</EmptyState>
    </div>
  );
}
