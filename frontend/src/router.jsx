import { Link, Navigate, createBrowserRouter } from 'react-router';
import { homePathFor, useAuth } from './auth/AuthContext.jsx';
import { ProtectedRoute } from './auth/ProtectedRoute.jsx';
import { AppShell } from './components/AppShell.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { AdminDashboard } from './pages/admin/Dashboard.jsx';
import { MeetingDetailPage } from './pages/admin/MeetingDetail.jsx';
import { MeetingNewPage } from './pages/admin/MeetingNew.jsx';
import { MeetingsPage } from './pages/admin/Meetings.jsx';
import { UsersPage } from './pages/admin/Users.jsx';
import { MyTasks } from './pages/employee/MyTasks.jsx';
import { TaskDetail } from './pages/employee/TaskDetail.jsx';

function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={homePathFor(user)} replace />;
}

function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3">
      <p className="text-slate-600">Page not found.</p>
      <Link to="/" className="text-sm font-medium text-slate-900 underline">
        Go home
      </Link>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <HomeRedirect /> },
          {
            element: <ProtectedRoute roles={['admin']} />,
            children: [
              { path: '/admin', element: <AdminDashboard /> },
              { path: '/admin/meetings', element: <MeetingsPage /> },
              { path: '/admin/meetings/new', element: <MeetingNewPage /> },
              { path: '/admin/meetings/:id', element: <MeetingDetailPage /> },
              { path: '/admin/users', element: <UsersPage /> },
            ],
          },
          {
            element: <ProtectedRoute roles={['employee']} />,
            children: [
              { path: '/my/tasks', element: <MyTasks /> },
              { path: '/my/tasks/:id', element: <TaskDetail /> },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
