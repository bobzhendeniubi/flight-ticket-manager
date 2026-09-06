/**
 * 功能开关（ADMIN 可改，STAFF 只读）
 *
 * 列出 FEATURE_FLAGS 注册表里的全部开关（提醒每日自动生成 / 企业微信群推送 / 顶栏铃铛全覆盖）。
 * 全部默认关闭——开关本身不影响任何现有行为，只有手动打开后新行为才会生效。
 * GET /settings/feature-flags 两种角色都能看；PUT /settings/feature-flags/:key 仅 ADMIN。
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type FeatureFlagKey, type FeatureFlagView } from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';

export function FeatureFlagsSettingsPage() {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const token = tokens?.accessToken ?? '';
  const canEdit = user?.role === 'ADMIN';

  const [flags, setFlags] = useState<FeatureFlagView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<FeatureFlagKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setLoadErr(null);
    api
      .getFeatureFlags(token)
      .then((res) => setFlags(res.flags))
      .catch((err: unknown) => setLoadErr(err instanceof ApiError ? err.message : '加载功能开关失败'))
      .finally(() => setLoading(false));
  }, [token]);

  async function toggle(key: FeatureFlagKey, next: boolean): Promise<void> {
    if (!token || !canEdit || pendingKey) return;
    setPendingKey(key);
    setError(null);
    try {
      const res = await api.setFeatureFlag(token, key, next);
      setFlags(res.flags);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setPendingKey(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-ink-muted">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        加载中…
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
        {loadErr}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">功能开关</h1>
        <p className="mt-1 text-sm text-ink-muted">
          新功能上线前的开关闸——全部默认关闭，不影响任何现有行为；确认口径后再手动打开。
          {!canEdit && '（STAFF 只读，改动需 ADMIN 操作）'}
        </p>
      </div>

      <div className="max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-sm">
        <ul className="divide-y divide-slate-100">
          {(flags ?? []).map((flag) => (
            <li key={flag.key} className="flex items-start justify-between gap-4 px-6 py-4">
              <div className="min-w-0">
                <p className="font-mono text-xs text-ink-muted">{flag.key}</p>
                <p className="mt-1 text-sm text-ink">{flag.label}</p>
                {flag.enabled !== flag.default && (
                  <p className="mt-1 text-xs text-amber-600">已偏离默认值（默认 {flag.default ? '开' : '关'}）</p>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={flag.enabled}
                aria-label={`${flag.label}${flag.enabled ? '（已开启）' : '（已关闭）'}`}
                disabled={!canEdit || pendingKey === flag.key}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  flag.enabled ? 'bg-brand' : 'bg-slate-300'
                }`}
                onClick={() => void toggle(flag.key, !flag.enabled)}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                    flag.enabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {error && (
        <div className="max-w-2xl rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <Icon name="close" className="mr-1 inline-block align-text-bottom" />
          {error}
        </div>
      )}
    </div>
  );
}
