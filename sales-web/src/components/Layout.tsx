import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';

export function Layout() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <span aria-hidden className="text-brand">✈︎</span>
            <span>Flight Ticket Manager</span>
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            {user ? (
              <>
                <Link to="/me" className="text-slate-700 hover:text-brand">
                  {user.displayName ?? user.email}
                </Link>
                <button
                  type="button"
                  className="btn-secondary text-sm py-1.5"
                  onClick={async () => {
                    await logout();
                    navigate('/');
                  }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <Link to="/login" className="text-slate-700 hover:text-brand">
                  Sign in
                </Link>
                <Link to="/register" className="btn-primary text-sm py-1.5">
                  Create account
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <div className="mx-auto w-full max-w-5xl px-4 py-8">
          <Outlet />
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white text-xs text-slate-500">
        <div className="mx-auto max-w-5xl px-4 py-4">
          Flight Ticket Manager · M1 Foundation · © {new Date().getFullYear()}
        </div>
      </footer>
    </div>
  );
}
