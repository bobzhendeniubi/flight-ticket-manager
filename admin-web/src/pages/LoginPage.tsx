import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
    if (user) navigate('/dashboard', { replace: true });
  }, [user, navigate]);

  useEffect(() => clearError(), [clearError]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
      navigate('/dashboard', { replace: true });
    } catch {
      // error rendered via store
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center text-white mb-6">
          <h1 className="text-2xl font-bold">世途旅行 · 后台</h1>
          <p className="mt-2 text-sm text-slate-400">运营端 / 管理员入口</p>
        </div>
        <div className="rounded-lg bg-white p-6 shadow-xl">
          <h2 className="text-lg font-semibold text-slate-900">账号登录</h2>
          <p className="mt-1 text-xs text-slate-500">仅 ADMIN / STAFF 角色可登录后台</p>

          <form className="mt-5 space-y-4" onSubmit={onSubmit}>
            <div>
              <label className="label" htmlFor="email">邮箱</label>
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
              <label className="label" htmlFor="password">密码</label>
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
              {isLoading ? '登录中…' : '登录后台'}
            </button>
          </form>

          <div className="mt-5 rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">开发管理员账号（密码 <code>Password123!</code>）</p>
            <p className="mt-1 font-mono">admin@ftm.local</p>
            <p className="mt-2 text-slate-500">
              代理或客户请到{' '}
              <a href="http://localhost:5173" className="text-brand hover:underline">
                前台 :5173
              </a>{' '}
              登录购买。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
