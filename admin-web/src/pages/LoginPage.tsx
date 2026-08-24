import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';

// 极简 console 登录页：居中卡片 + 克制靛蓝，工具气质
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
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm animate-fade-in">
        {/* Logo 锁定区 */}
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">
            世
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-ink">世途旅行 · 运营后台</p>
            <p className="text-xs text-ink-muted">Operations Console</p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
          <h1 className="text-lg font-semibold text-ink">登录</h1>
          <p className="mt-1 text-xs text-ink-soft">
            ADMIN / STAFF 见全部数据；AGENT 仅限自己树内的订单、客户、结算。
          </p>

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
              <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {error}
              </p>
            )}
            <button type="submit" className="btn-primary w-full" disabled={isLoading}>
              {isLoading ? '登录中…' : '登录后台'}
            </button>
          </form>

          {/* 开发账号提示：**只在本地 dev 出现**。
              这块曾经无条件渲染，等于把运营全权限账号的邮箱和密码印在公网登录页上，
              任何人打开后台首页就能抄走。import.meta.env.DEV 在 vite build 产物里是
              false，整块会被 tree-shake 掉，生产构建里连字符串都不存在。 */}
          {import.meta.env.DEV && (
            <div className="mt-5 rounded-lg border border-slate-100 bg-canvas p-3 text-xs text-ink-soft">
              <p className="font-medium text-ink-soft">
                开发账号 · 密码 <code className="rounded bg-white px-1 py-0.5 text-brand-700">Password123!</code>
              </p>
              <p className="mt-1.5 font-mono text-[11px]">admin@ftm.local · 运营全权限</p>
              <p className="mt-1 font-mono text-[11px]">agent1@ftm.local · 代理端（只看自己树）</p>
            </div>
          )}
        </div>

        {/* 前台入口：写死 localhost 在生产上是个死链。用相对于当前域名的前台地址——
            admin.xxx → store.xxx，测试环境 test-admin.xxx → test-store.xxx 也自动对。 */}
        <p className="mt-4 text-center text-xs text-ink-muted">
          客户购买请前往{' '}
          <a
            href={
              import.meta.env.DEV
                ? 'http://localhost:5173'
                : window.location.origin.replace('admin', 'store')
            }
            className="font-medium text-brand hover:underline"
          >
            前台商城
          </a>
        </p>
      </div>
    </div>
  );
}
