/**
 * 账号管理（仅 ADMIN）。
 * 岗位仍决定 STAFF 导出裁剪；账号本身还负责内部开户、停用/启用与临时密码重置。
 */
import { Fragment, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, type StaffRole, type StaffUser } from '../lib/api';
import { useAuth } from '../stores/auth';

const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  VISA_DESK: '签证岗',
  TICKETING: '票务岗',
  ROOM_CONTROL: '房控岗',
};

const PASSWORD_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomPassword(length = 12): string {
  const bytes = new Uint32Array(length + 3);
  crypto.getRandomValues(bytes);
  const required = [
    'abcdefghijklmnopqrstuvwxyz'[bytes[0] % 26],
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[bytes[1] % 26],
    '0123456789'[bytes[2] % 10],
  ];
  for (let i = required.length; i < length; i++) {
    required.push(PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length]);
  }
  for (let i = required.length - 1; i > 0; i--) {
    const j = bytes[i + 3] % (i + 1);
    [required[i], required[j]] = [required[j], required[i]];
  }
  return required.join('');
}

export function StaffRolesPage() {
  const tokens = useAuth((s) => s.tokens);
  const currentUser = useAuth((s) => s.user);
  const token = tokens?.accessToken ?? '';
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<StaffUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetSecret, setResetSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [form, setForm] = useState({
    email: '',
    displayName: '',
    role: 'STAFF' as 'STAFF' | 'ADMIN',
    staffRole: '' as StaffRole | '',
    password: '',
  });

  const load = () => {
    if (!token) return;
    setLoading(true);
    api
      .listStaff(token)
      .then((r) => setStaff(r.staff))
      .catch((e) => setErr(e instanceof ApiError ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [token]);

  const setRole = async (u: StaffUser, next: StaffRole | null) => {
    if (!token || savingId) return;
    setErr(null);
    setOk(null);
    setSavingId(u.id);
    try {
      await api.setStaffRole(token, u.id, next);
      setStaff((cur) => cur.map((x) => (x.id === u.id ? { ...x, staffRole: next } : x)));
      setOk(`${u.displayName ?? u.email ?? u.id} → ${next ? STAFF_ROLE_LABEL[next] : '通用运营'}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSavingId(null);
    }
  };

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || creating) return;
    setErr(null);
    setOk(null);
    setCreating(true);
    try {
      await api.createStaffUser(token, {
        email: form.email,
        password: form.password,
        displayName: form.displayName,
        role: form.role,
        staffRole: form.role === 'STAFF' && form.staffRole ? form.staffRole : null,
      });
      setOk('账号已创建，初始密码请当面/私聊交给本人，对方首次登录会被要求改密');
      setForm({ email: '', displayName: '', role: 'STAFF', staffRole: '', password: '' });
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const toggleDisabled = async (u: StaffUser) => {
    if (!token || savingId) return;
    const next = !u.disabledAt;
    const prompt = next
      ? '停用后该账号所有会话立即失效，确定继续吗？'
      : '确定启用这个账号吗？';
    if (!window.confirm(prompt)) return;
    setErr(null);
    setOk(null);
    setSavingId(u.id);
    try {
      const result = await api.setUserDisabled(token, u.id, next);
      setStaff((cur) =>
        cur.map((x) => (x.id === u.id ? { ...x, disabledAt: result.disabledAt } : x)),
      );
      setOk(next ? '账号已停用，所有会话已失效' : '账号已启用');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '状态更新失败');
    } finally {
      setSavingId(null);
    }
  };

  const submitReset = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !resetting || savingId) return;
    setErr(null);
    setOk(null);
    setSavingId(resetting.id);
    try {
      await api.resetUserPassword(token, resetting.id, resetPassword);
      setResetSecret(resetPassword);
      setOk(`已重置 ${resetting.displayName ?? resetting.email ?? resetting.id} 的密码，请将临时密码只转交本人`);
      setResetting(null);
      setResetPassword('');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '重置失败');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <section>
        <h1 className="page-title">账号管理</h1>
        <p className="page-sub">
          管理内部 ADMIN/STAFF 账号、岗位与会话状态。新建或重置密码后，对方首次登录必须先修改密码。
        </p>
      </section>

      {err && <div className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
      {ok && <div className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">✅ {ok}</div>}
      {resetSecret && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          本次临时密码（仅在此处展示，请立即转交本人）：<code className="ml-1 font-bold">{resetSecret}</code>
        </div>
      )}

      <section className="card">
        <h2 className="text-base font-semibold text-ink">新建内部账号</h2>
        <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={createUser}>
          <label className="text-sm text-ink-soft">
            邮箱
            <input
              className="input mt-1 w-full"
              type="email"
              required
              maxLength={255}
              value={form.email}
              onChange={(e) => setForm((x) => ({ ...x, email: e.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-soft">
            显示名
            <input
              className="input mt-1 w-full"
              required
              maxLength={100}
              value={form.displayName}
              onChange={(e) => setForm((x) => ({ ...x, displayName: e.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-soft">
            角色
            <select
              className="input mt-1 w-full"
              value={form.role}
              onChange={(e) =>
                setForm((x) => ({ ...x, role: e.target.value as 'STAFF' | 'ADMIN', staffRole: e.target.value === 'STAFF' ? x.staffRole : '' }))
              }
            >
              <option value="STAFF">STAFF</option>
              <option value="ADMIN">ADMIN</option>
            </select>
          </label>
          {form.role === 'STAFF' ? (
            <label className="text-sm text-ink-soft">
              岗位
              <select
                className="input mt-1 w-full"
                value={form.staffRole}
                onChange={(e) => setForm((x) => ({ ...x, staffRole: e.target.value as StaffRole | '' }))}
              >
                <option value="">通用运营（全模板）</option>
                {Object.entries(STAFF_ROLE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
          ) : <div />}
          <label className="text-sm text-ink-soft md:col-span-2">
            初始密码
            <div className="mt-1 flex gap-2">
              <input
                className="input min-w-0 flex-1 font-mono"
                type="text"
                required
                minLength={8}
                maxLength={128}
                value={form.password}
                onChange={(e) => setForm((x) => ({ ...x, password: e.target.value }))}
              />
              <button type="button" className="btn-secondary shrink-0" onClick={() => setForm((x) => ({ ...x, password: randomPassword() }))}>
                随机生成
              </button>
            </div>
          </label>
          <div className="md:col-span-2">
            <button type="submit" className="btn-primary" disabled={creating}>
              {creating ? '创建中…' : '创建账号'}
            </button>
          </div>
        </form>
      </section>

      <section className="card overflow-x-auto">
        {loading ? (
          <div className="py-8 text-center text-sm text-ink-muted">加载中…</div>
        ) : (
          <table className="table-admin min-w-[900px]">
            <thead>
              <tr>
                <th className="text-left">账号</th>
                <th className="text-left">邮箱</th>
                <th className="text-left">角色</th>
                <th className="text-left">岗位</th>
                <th className="text-left">状态</th>
                <th className="text-left">最近登录</th>
                <th className="text-left">操作</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((u) => (
                <Fragment key={u.id}>
                  <tr className={u.disabledAt ? 'opacity-60' : undefined}>
                    <td className="font-medium text-ink">{u.displayName ?? '—'}</td>
                    <td className="text-ink-soft">{u.email ?? '—'}</td>
                    <td>
                      <span className={u.role === 'ADMIN' ? 'badge-warning' : 'badge-neutral'}>
                        {u.role === 'ADMIN' ? '管理员' : '运营'}
                      </span>
                    </td>
                    <td>
                      {u.role === 'ADMIN' ? (
                        <span className="text-xs text-ink-muted">全能（不设岗）</span>
                      ) : (
                        <select
                          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                          value={u.staffRole ?? ''}
                          disabled={savingId === u.id}
                          onChange={(e) => setRole(u, (e.target.value || null) as StaffRole | null)}
                        >
                          <option value="">通用运营（全模板）</option>
                          {Object.entries(STAFF_ROLE_LABEL).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {u.disabledAt ? (
                        <span className="badge-danger">已停用</span>
                      ) : u.mustChangePassword ? (
                        <span className="badge-warning">待改密</span>
                      ) : (
                        <span className="badge-neutral">正常</span>
                      )}
                    </td>
                    <td className="text-xs text-ink-muted">{u.lastLoginAt ? u.lastLoginAt.slice(0, 10) : '从未'}</td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        {currentUser?.id !== u.id && (
                          <button type="button" className="btn-secondary py-1 text-xs" disabled={savingId === u.id} onClick={() => void toggleDisabled(u)}>
                            {u.disabledAt ? '启用' : '停用'}
                          </button>
                        )}
                        {currentUser?.id !== u.id && (
                          <button
                            type="button"
                            className="btn-secondary py-1 text-xs"
                            disabled={savingId === u.id}
                            onClick={() => {
                              setResetting(u);
                              setResetPassword(randomPassword());
                              setResetSecret(null);
                            }}
                          >
                            重置密码
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {resetting?.id === u.id && (
                    <tr key={`${u.id}-reset`}>
                      <td colSpan={7} className="bg-slate-50">
                        <form className="flex flex-wrap items-end gap-2" onSubmit={submitReset}>
                          <label className="text-xs text-ink-soft">
                            新临时密码
                            <input className="input mt-1 font-mono" required minLength={8} maxLength={128} value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} />
                          </label>
                          <button type="button" className="btn-secondary py-1.5 text-xs" onClick={() => setResetPassword(randomPassword())}>随机生成</button>
                          <button type="submit" className="btn-primary py-1.5 text-xs" disabled={savingId === u.id}>确认重置</button>
                          <button type="button" className="btn-secondary py-1.5 text-xs" onClick={() => setResetting(null)}>取消</button>
                        </form>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {staff.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-ink-muted">无内部账号</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
