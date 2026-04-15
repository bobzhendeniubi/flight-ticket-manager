import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const isLoading = useAuth((s) => s.isLoading);
  const error = useAuth((s) => s.error);
  const clearError = useAuth((s) => s.clearError);
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (user) navigate('/me', { replace: true });
  }, [user, navigate]);

  useEffect(() => clearError(), [clearError]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
      navigate('/me', { replace: true });
    } catch {
      // error surfaced via store
    }
  };

  return (
    <div className="mx-auto max-w-sm">
      <div className="card">
        <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
        <p className="mt-1 text-sm text-slate-600">Welcome back. Enter your credentials to continue.</p>

        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={1}
            />
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <button type="submit" className="btn-primary w-full" disabled={isLoading}>
            {isLoading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-slate-600">
          No account?{' '}
          <Link to="/register" className="font-medium text-brand hover:text-brand-dark">
            Create one
          </Link>
        </p>
      </div>

      <p className="mt-4 text-center text-xs text-slate-400">
        Dev seed: <code>admin@ftm.local</code> / <code>Password123!</code>
      </p>
    </div>
  );
}
