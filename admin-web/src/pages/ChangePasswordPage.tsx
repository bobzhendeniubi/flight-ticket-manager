import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../stores/auth';

export function ChangePasswordPage() {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!tokens || saving) return;
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setSaving(true);
    try {
      const result = await api.changePassword(tokens.accessToken, currentPassword, newPassword);
      useAuth.setState({ user: result.user, tokens: result.tokens });
      setSuccess(true);
      window.setTimeout(() => navigate('/'), 500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '修改密码失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg">
      <section className="card">
        <h1 className="page-title">修改密码</h1>
        <p className="mt-1 text-sm text-ink-soft">为账号设置一个只有你知道的新密码。</p>

        {user?.mustChangePassword && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
            管理员为你设置了初始密码，需先修改为自己的密码才能继续使用。
          </div>
        )}
        {error && <div className="mt-4 rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>}
        {success && <div className="mt-4 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700">密码修改成功，正在进入系统…</div>}

        <form className="mt-5 space-y-4" onSubmit={submit}>
          <label className="label">
            当前密码
            <input className="input mt-1" type="password" required maxLength={128} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <label className="label">
            新密码
            <input className="input mt-1" type="password" required minLength={8} maxLength={128} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="label">
            确认新密码
            <input className="input mt-1" type="password" required minLength={8} maxLength={128} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <button type="submit" className="btn-primary w-full" disabled={saving || success}>
            {saving ? '保存中…' : '确认修改'}
          </button>
        </form>
      </section>
    </div>
  );
}
