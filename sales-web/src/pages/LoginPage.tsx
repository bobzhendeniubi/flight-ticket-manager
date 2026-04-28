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
    if (user) navigate('/me', { replace: true });
  }, [user, navigate]);

  useEffect(() => clearError(), [clearError]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
      navigate('/me', { replace: true });
    } catch {
      // 错误通过 store 显示
    }
  };

  return (
    <div className="mx-auto max-w-sm">
      <div className="card">
        <h1 className="text-xl font-semibold text-slate-900">账号登录</h1>
        <p className="mt-1 text-sm text-slate-600">欢迎回来，请输入登录信息。</p>

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
            {isLoading ? '登录中…' : '登录'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-slate-600">
          还没有账号？请联系您的销售代理为您开通。
        </p>
      </div>

      <div className="mt-4 rounded-md bg-slate-50 p-3 text-xs text-slate-600">
        <p className="font-medium text-slate-700">开发环境演示账号（密码均为 <code>Password123!</code>）</p>
        <ul className="mt-1 space-y-0.5">
          <li>管理员：<code>admin@ftm.local</code></li>
          <li>1级代理：<code>agent1@ftm.local</code></li>
          <li>2级代理：<code>agent2@ftm.local</code></li>
          <li>3级代理：<code>agent3@ftm.local</code></li>
          <li>客户：<code>customer@ftm.local</code></li>
        </ul>
      </div>
    </div>
  );
}
