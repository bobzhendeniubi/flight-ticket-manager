import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../stores/auth';

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
      <div className="card">
        <p className="text-red-700">{error}</p>
      </div>
    );
  }

  if (!user) {
    return <div className="card text-slate-500">正在加载资料…</div>;
  }

  return (
    <div className="card max-w-xl">
      <h1 className="text-xl font-semibold text-slate-900">我的资料</h1>
      <dl className="mt-4 divide-y divide-slate-200">
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
          <div key={label} className="flex justify-between py-2 text-sm">
            <dt className="font-medium text-slate-600">{label}</dt>
            <dd className="text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
