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
      window.setTimeout(() => navigate('/me'), 500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '修改密码失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <section className="card animate-fade-up">
        <div className="mb-6">
          <p className="text-sm font-semibold text-brand-700">账户安全</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">修改密码</h1>
          <p className="mt-2 text-sm text-ink-soft">为了你的账户安全，请设置一个只有你知道的新密码。</p>
        </div>

        {user?.mustChangePassword && (
          <div className="mb-5 rounded-2xl border border-sun/30 bg-sun-light px-4 py-3 text-sm leading-6 text-amber-900">
            这是管理员为你设置的初始密码。请先修改为自己的密码，再继续使用账户。
          </div>
        )}
        {error && <div className="mb-5 rounded-2xl border border-deal/20 bg-deal-light px-4 py-3 text-sm text-deal-dark">{error}</div>}
        {success && <div className="mb-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">密码修改成功，正在返回个人资料…</div>}

        <form className="space-y-4" onSubmit={submit}>
          <label className="block text-sm font-semibold text-ink-soft">
            当前密码
            <input className="input mt-1.5" type="password" required maxLength={128} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <label className="block text-sm font-semibold text-ink-soft">
            新密码
            <input className="input mt-1.5" type="password" required minLength={8} maxLength={128} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="block text-sm font-semibold text-ink-soft">
            确认新密码
            <input className="input mt-1.5" type="password" required minLength={8} maxLength={128} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <button type="submit" className="btn-primary w-full" disabled={saving || success}>
            {saving ? '保存中…' : '保存新密码'}
          </button>
        </form>
      </section>
    </div>
  );
}
