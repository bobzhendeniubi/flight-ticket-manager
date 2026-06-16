import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { Icon, type IconName } from '../components/Icon';

// 沉浸式海岛 split 登录页（OTA 气质）：左侧全幅岘港海景 + 卖点，右侧登录卡
const HERO_IMG =
  'https://images.unsplash.com/photo-1559592413-7cec4d0cae2b?auto=format&fit=crop&w=1400&q=80';

const SELLING_POINTS: Array<{ icon: IconName; text: string }> = [
  { icon: 'plane', text: '澳门 ⇌ 岘港 每日直飞，每天一班' },
  { icon: 'package', text: '机票 · 酒店含早 · 签证 · 地面服务一价全含' },
  { icon: 'support', text: '中文客服全程在线，落地无忧' },
];

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
    <div className="min-h-screen w-full lg:grid lg:grid-cols-[1.05fr_1fr]">
      {/* ── 左：沉浸式海景（手机端为顶部短横幅） ── */}
      <aside className="relative overflow-hidden bg-brand-900">
        <img
          src={HERO_IMG}
          alt="岘港海岸"
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-tr from-brand-900/85 via-brand-800/55 to-brand-600/30" />
        <div className="relative flex h-44 flex-col justify-end p-6 lg:h-full lg:justify-between lg:p-12">
          <Link to="/" className="hidden items-center gap-2 text-lg font-extrabold text-white lg:flex">
            <Icon name="plane" className="h-5 w-5" />
            <span>世途旅行</span>
          </Link>
          <div className="text-white">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/80">
              澳门 · 越南海岛专线
            </p>
            <h1 className="mt-2 max-w-md text-3xl font-extrabold leading-tight drop-shadow-sm lg:text-[2.6rem]">
              一价全含，<br className="hidden lg:block" />说走就走的海岛假期
            </h1>
            <ul className="mt-6 hidden space-y-3 lg:block">
              {SELLING_POINTS.map((p) => (
                <li key={p.text} className="flex items-center gap-3 text-white/90">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
                    <Icon name={p.icon} className="h-5 w-5" />
                  </span>
                  <span className="font-medium">{p.text}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="hidden text-xs text-white/60 lg:block">© {new Date().getFullYear()} 世途旅行 · CITUR TRAVEL</p>
        </div>
      </aside>

      {/* ── 右：登录卡 ── */}
      <main className="flex flex-1 items-center justify-center px-5 py-10 lg:px-12">
        <div className="w-full max-w-sm animate-fade-up">
          <Link to="/" className="mb-8 flex items-center gap-2 text-xl font-extrabold text-brand lg:hidden">
            <Icon name="plane" className="h-5 w-5" />
            <span>世途旅行</span>
          </Link>

          <h2 className="text-2xl font-extrabold text-ink">欢迎回来</h2>
          <p className="mt-1.5 text-sm text-ink-soft">登录后查看订单、继续未完成的预订。</p>

          <form className="mt-7 space-y-4" onSubmit={onSubmit}>
            <div>
              <label className="label" htmlFor="email">邮箱</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
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
                placeholder="••••••••"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={1}
              />
            </div>
            {error && (
              <p role="alert" className="rounded-xl bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                {error}
              </p>
            )}
            <button type="submit" className="btn-primary w-full" disabled={isLoading}>
              {isLoading ? '登录中…' : '登录'}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-ink-soft">
            还没有账号？请联系您的销售代理为您开通。
          </p>

          <div className="mt-8 rounded-2xl border border-slate-200/70 bg-canvas p-4 text-xs text-ink-soft">
            <p className="font-semibold text-ink-soft">
              演示账号 · 密码均为 <code className="rounded bg-white px-1 py-0.5 text-brand-700">Password123!</code>
            </p>
            <div className="mt-2 grid grid-cols-1 gap-1 font-mono text-[11px]">
              <span>customer@ftm.local · 客户</span>
              <span>agent1@ftm.local · 一级代理</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
