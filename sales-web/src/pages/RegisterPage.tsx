import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';

export function RegisterPage() {
  const register = useAuth((s) => s.register);
  const isLoading = useAuth((s) => s.isLoading);
  const error = useAuth((s) => s.error);
  const clearError = useAuth((s) => s.clearError);
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (user) navigate('/me', { replace: true });
  }, [user, navigate]);

  useEffect(() => clearError(), [clearError]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await register(email, password, displayName || undefined);
      navigate('/me', { replace: true });
    } catch {
      // 错误通过 store 显示
    }
  };

  return (
    <div className="mx-auto max-w-sm">
      <div className="card">
        <h1 className="text-xl font-semibold text-slate-900">注册账号</h1>
        <p className="mt-1 text-sm text-slate-600">密码至少 8 位。代理账号由上级代理或管理员创建。</p>

        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="label" htmlFor="displayName">昵称（选填）</label>
            <input
              id="displayName"
              type="text"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={100}
            />
          </div>
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
              autoComplete="new-password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <button type="submit" className="btn-primary w-full" disabled={isLoading}>
            {isLoading ? '创建中…' : '创建账号'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-slate-600">
          已有账号？{' '}
          <Link to="/login" className="font-medium text-brand hover:text-brand-dark">
            去登录
          </Link>
        </p>
      </div>
    </div>
  );
}
