import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';
import { Link } from 'react-router-dom';

interface FullUser {
  id: string;
  email: string | null;
  phone: string | null;
  role: string;
  displayName: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  CUSTOMER: '客户',
  AGENT: '代理',
  STAFF: '运营',
  ADMIN: '管理员',
};

export function ProfilePage() {
  const tokens = useAuth((s) => s.tokens);
  const [user, setUser] = useState<FullUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tokens) return;
    api.me(tokens.accessToken)
      .then((res) => setUser(res.user))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : '加载资料失败');
      });
  }, [tokens]);

  if (error) {
    return (
      <div className="card border-deal/30 bg-deal-light">
        <p className="font-medium text-deal-dark">{error}</p>
      </div>
    );
  }

  if (!user) {
    return <div className="card text-ink-muted">正在加载资料…</div>;
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="card animate-fade-up">
        {/* 顶部身份卡 */}
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-3xl font-bold text-brand">
            {user.displayName?.trim()?.[0] ?? <Icon name="user" className="h-7 w-7" />}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-extrabold tracking-tight text-ink">
              {user.displayName ?? '我的资料'}
            </h1>
            <div className="mt-1 flex items-center gap-2">
              <span className="badge-soft">{ROLE_LABEL[user.role] ?? user.role}</span>
              {user.emailVerified && <span className="badge-sun">已验证</span>}
            </div>
          </div>
        </div>

        {user.email && (
          <Link to="/change-password" className="btn-secondary mt-5 inline-flex">
            修改密码
          </Link>
        )}

        <dl className="mt-5 divide-y divide-slate-100">
          {[
            ['用户 ID', user.id],
            ['邮箱', user.email ?? '—'],
            ['昵称', user.displayName ?? '—'],
            ['手机号', user.phone ?? '—'],
            ['角色', ROLE_LABEL[user.role] ?? user.role],
            ['邮箱已验证', user.emailVerified ? '是' : '否'],
            ['注册时间', new Date(user.createdAt).toLocaleString('zh-CN')],
            ['上次登录', user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('zh-CN') : '—'],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <dt className="font-medium text-ink-muted">{label}</dt>
              <dd className="truncate text-right font-medium text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
