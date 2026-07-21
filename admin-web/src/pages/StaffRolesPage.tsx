/**
 * 岗位管理（A20 岗位细分，仅 ADMIN）
 *
 * 给 STAFF 账号赋内部岗位（签证岗/票务岗/房控岗；空 = 通用运营）。
 * 岗位决定导出裁剪：专岗账号导「全岗总表」被强制裁到本岗模板——改 URL 参数
 * 也拿不到订单成本/结算价等全岗列（服务端按账号身份判，见 /orders/export/master）。
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type StaffRole, type StaffUser } from '../lib/api';
import { useAuth } from '../stores/auth';

const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  VISA_DESK: '签证岗',
  TICKETING: '票务岗',
  ROOM_CONTROL: '房控岗',
};

export function StaffRolesPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

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
      window.setTimeout(() => setOk(null), 2500);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <section>
        <h1 className="page-title">岗位管理</h1>
        <p className="page-sub">
          给 STAFF 账号赋内部岗位。专岗账号导「全岗总表」会被强制裁到本岗模板（签证/票务），
          看不到订单成本、结算价等全岗列；留空 = 通用运营（全模板可导）。变更记入审计。
        </p>
      </section>

      {err && <div className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
      {ok && <div className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">✅ {ok}</div>}

      <section className="card overflow-x-auto">
        {loading ? (
          <div className="py-8 text-center text-sm text-ink-muted">加载中…</div>
        ) : (
          <table className="table-admin">
            <thead>
              <tr>
                <th className="text-left">账号</th>
                <th className="text-left">邮箱</th>
                <th className="text-left">角色</th>
                <th className="text-left">岗位</th>
                <th className="text-left">最近登录</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((u) => (
                <tr key={u.id}>
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
                        onChange={(e) =>
                          setRole(u, (e.target.value || null) as StaffRole | null)
                        }
                      >
                        <option value="">通用运营（全模板）</option>
                        <option value="VISA_DESK">签证岗（只导签证模板）</option>
                        <option value="TICKETING">票务岗（只导票务模板）</option>
                        <option value="ROOM_CONTROL">房控岗（总表限最小金额面）</option>
                      </select>
                    )}
                  </td>
                  <td className="text-xs text-ink-muted">
                    {u.lastLoginAt ? u.lastLoginAt.slice(0, 10) : '从未'}
                  </td>
                </tr>
              ))}
              {staff.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-ink-muted">无内部账号</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
