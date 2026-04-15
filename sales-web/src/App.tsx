import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ProfilePage } from './pages/ProfilePage';
import { TeamPage } from './pages/TeamPage';
import { AdminFlightsPage } from './pages/AdminFlightsPage';
import { useAuth } from './stores/auth';
import type { UserRole } from './lib/api';

function Protected({
  children,
  roles,
}: {
  children: React.ReactNode;
  roles?: UserRole[];
}) {
  const user = useAuth((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route
          path="me"
          element={
            <Protected>
              <ProfilePage />
            </Protected>
          }
        />
        <Route
          path="team"
          element={
            <Protected roles={['AGENT', 'ADMIN', 'STAFF']}>
              <TeamPage />
            </Protected>
          }
        />
        <Route
          path="admin/flights"
          element={
            <Protected roles={['ADMIN', 'STAFF']}>
              <AdminFlightsPage />
            </Protected>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
