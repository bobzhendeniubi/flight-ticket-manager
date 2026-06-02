/**
 * 取消政策管理 — Admin/Staff 配费率阶梯。
 *
 * 每个产品 kind 一条「默认」策略；客服可以加针对特定 entity 的覆盖（scope）。
 * 改完前台 GET /orders/:id/refund-quote 立即用新规则。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CancellationPolicy, type CancellationTier, type ProductKind } from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';

type DraftTier = { hoursBeforeDeparture: number | null; feePercent: number | null };
const draftToTier = (t: DraftTier): CancellationTier => ({
  hoursBeforeDeparture: t.hoursBeforeDeparture ?? 0,
  feePercent: Math.max(0, Math.min(100, t.feePercent ?? 0)),
});
const tierToDraft = (t: CancellationTier): DraftTier => ({
  hoursBeforeDeparture: t.hoursBeforeDeparture,
  feePercent: t.feePercent,
});

const KIND_LABEL: Record<ProductKind, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '接送',
  VISA: '签证',
  BUNDLE: '套餐',
  INSURANCE: '保险',
};

export function CancellationPoliciesPage() {
  const tokens = useAuth((s) => s.tokens);
  const [policies, setPolicies] = useState<CancellationPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tokens) return;
    setLoading(true);
    try {
      const r = await api.listCancellationPolicies(tokens.accessToken);
      setPolicies(r.policies);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [tokens]);

  useEffect(() => { void load(); }, [load]);

  const flash = (msg: string) => {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(null), 3000);
  };

  const update = async (id: string, body: Record<string, unknown>) => {
    if (!tokens) return;
    try {
      await api.updateCancellationPolicy(tokens.accessToken, id, body);
      await load();
      flash('✓ 已保存（前台 /refund-quote 立即生效）');
      setEditingId(null);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : '保存失败');
    }
  };

  const remove = async (id: string, name: string) => {
    if (!tokens) return;
    if (!confirm(`确定删除「${name}」？`)) return;
    try {
      await api.deleteCancellationPolicy(tokens.accessToken, id);
      await load();
      flash('已删除');
    } catch (e) {
      alert(e instanceof ApiError ? e.message : '删除失败');
    }
  };

  if (loading) return <div className="card text-slate-500">加载中…</div>;
  if (error) return <div className="card border-red-200 bg-red-50 text-red-700">{error}</div>;

  return (
    <div className="space-y-5">
      <section>
        <h1 className="text-2xl font-bold text-slate-900">取消订单 · 退款手续费规则</h1>
        <p className="mt-1 text-sm text-slate-600">
          客户申请取消时按这里的费率阶梯算手续费。改完立即生效（前台 GET /refund-quote 实时算）。
        </p>
      </section>

      {savedFlash && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
          {savedFlash}
        </div>
      )}

      <div className="flex justify-end">
        <button className="btn-primary text-sm" onClick={() => setShowCreate(true)}>
          + 新建策略
        </button>
      </div>

      <div className="space-y-3">
        {policies.map((p) => (
          <PolicyCard
            key={p.id}
            policy={p}
            editing={editingId === p.id}
            onEdit={() => setEditingId(p.id)}
            onCancel={() => setEditingId(null)}
            onSave={(body) => update(p.id, body)}
            onDelete={() => remove(p.id, p.name)}
          />
        ))}
        {policies.length === 0 && (
          <div className="card text-slate-500 text-center py-12">
            还没有任何取消策略。点右上角「新建」开始配置，或运行 npm run prisma:seed 拉默认值。
          </div>
        )}
      </div>

      {showCreate && (
        <CreatePolicyModal
          existingKinds={new Set(policies.filter((p) => p.isDefault).map((p) => p.productKind))}
          onCancel={() => setShowCreate(false)}
          onSubmit={async (body) => {
            if (!tokens) return;
            try {
              await api.createCancellationPolicy(tokens.accessToken, body);
              await load();
              setShowCreate(false);
              flash('✓ 已创建');
            } catch (e) {
              alert(e instanceof ApiError ? e.message : '创建失败');
            }
          }}
        />
      )}
    </div>
  );
}

// ── 单条策略卡片 ──
function PolicyCard({
  policy, editing, onEdit, onCancel, onSave, onDelete,
}: {
  policy: CancellationPolicy;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(policy.name);
  const [tiers, setTiers] = useState<DraftTier[]>(policy.tiers.map(tierToDraft));
  const [notes, setNotes] = useState(policy.notes ?? '');
  const [isDefault, setIsDefault] = useState(policy.isDefault);

  useEffect(() => {
    setName(policy.name);
    setTiers(policy.tiers.map(tierToDraft));
    setNotes(policy.notes ?? '');
    setIsDefault(policy.isDefault);
  }, [policy]);

  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
              {KIND_LABEL[policy.productKind]}
            </span>
            {policy.isDefault && (
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">默认</span>
            )}
            {policy.scope && policy.scope !== '__DEFAULT__' && (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                覆盖：{policy.scope}
              </span>
            )}
          </div>
          {!editing && (
            <h3 className="mt-1 font-semibold text-slate-900">{policy.name}</h3>
          )}
          {editing && (
            <input
              className="input mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </div>
        <div className="flex gap-2">
          {!editing && (
            <>
              <button className="btn-secondary text-sm" onClick={onEdit}>编辑</button>
              {!policy.isDefault && (
                <button
                  className="text-sm rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-red-700 hover:bg-red-100"
                  onClick={onDelete}
                >
                  删除
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* tiers 表 */}
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs">
            <tr>
              <th className="px-3 py-2 text-left">距离出发 ≥</th>
              <th className="px-3 py-2 text-left">手续费比例</th>
              {editing && <th className="px-3 py-2 text-right"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tiers.map((t, i) => {
              const hours = t.hoursBeforeDeparture ?? 0;
              const fee = t.feePercent ?? 0;
              return (
              <tr key={i}>
                <td className="px-3 py-2">
                  {editing ? (
                    <NumberInput
                      className="input w-32"
                      value={t.hoursBeforeDeparture}
                      onChange={(n) => {
                        setTiers((prev) => prev.map((x, j) => j === i ? { ...x, hoursBeforeDeparture: n } : x));
                      }}
                      allowNegative
                      integerOnly
                    />
                  ) : (
                    <span className="font-mono">
                      {hours === -1 ? '已履约 / 已起飞' : `${hours} 小时`}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {editing ? (
                    <div className="flex items-center gap-1">
                      <NumberInput
                        min={0}
                        max={100}
                        className="input w-24"
                        value={t.feePercent}
                        onChange={(n) => {
                          setTiers((prev) => prev.map((x, j) => j === i ? { ...x, feePercent: n } : x));
                        }}
                      />
                      <span className="text-slate-500">%</span>
                    </div>
                  ) : (
                    <span
                      className={`font-semibold ${
                        fee >= 80 ? 'text-red-600' :
                        fee >= 50 ? 'text-amber-600' :
                        fee > 0 ? 'text-slate-700' : 'text-emerald-600'
                      }`}
                    >
                      {fee}% {fee === 0 && '（免费）'}
                    </span>
                  )}
                </td>
                {editing && (
                  <td className="px-3 py-2 text-right">
                    <button
                      className="text-xs text-red-600 hover:underline"
                      onClick={() => setTiers((prev) => prev.filter((_, j) => j !== i))}
                    >
                      删除
                    </button>
                  </td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
        {editing && (
          <button
            className="mt-2 text-xs text-brand hover:underline"
            onClick={() =>
              setTiers((prev) => [...prev, { hoursBeforeDeparture: 0, feePercent: 50 }])
            }
          >
            + 添加阶梯
          </button>
        )}
      </div>

      {/* notes + isDefault */}
      <div className="mt-3 text-xs text-slate-500">
        {editing ? (
          <>
            <label className="label mt-2">备注</label>
            <input
              className="input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="可选"
            />
            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              <span>设为该产品类型的默认策略</span>
            </label>
          </>
        ) : (
          policy.notes && <div>📝 {policy.notes}</div>
        )}
      </div>

      {editing && (
        <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button className="btn-secondary" onClick={onCancel}>取消</button>
          <button
            className="btn-primary"
            onClick={() =>
              onSave({
                name,
                tiers: tiers.map(draftToTier),
                notes: notes || null,
                isDefault,
              })
            }
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}

// ── 新建策略 modal ──
function CreatePolicyModal({
  existingKinds, onCancel, onSubmit,
}: {
  existingKinds: Set<ProductKind>;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const KIND_OPTIONS: ProductKind[] = ['FLIGHT', 'HOTEL', 'TRANSFER', 'VISA', 'BUNDLE'];
  const firstAvailable = KIND_OPTIONS.find((k) => !existingKinds.has(k)) ?? 'FLIGHT';
  const [productKind, setProductKind] = useState<ProductKind>(firstAvailable);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('');
  const [tiers, setTiers] = useState<DraftTier[]>([
    { hoursBeforeDeparture: 168, feePercent: 5 },
    { hoursBeforeDeparture: 24, feePercent: 50 },
    { hoursBeforeDeparture: -1, feePercent: 100 },
  ]);

  const isOverride = !!scope.trim();
  const valid = name.trim().length > 0 && tiers.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 border-b border-slate-200 bg-white px-5 py-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">新建取消策略</h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onCancel}>×</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="label">产品类型</label>
            <select
              className="input"
              value={productKind}
              onChange={(e) => setProductKind(e.target.value as ProductKind)}
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]} {existingKinds.has(k) ? '（已有默认，新建为覆盖）' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">策略名称</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：国庆班次特殊政策"
            />
          </div>
          <div>
            <label className="label">作用范围（可选）</label>
            <input
              className="input"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="可选；填 scheduleId / hotelRoomTypeId 限定，不填即默认策略"
            />
            <p className="mt-1 text-xs text-slate-500">
              {isOverride
                ? '⚠ 这是一条覆盖策略，针对特定 entity 才生效'
                : `⚠ 不填 = 该 ${KIND_LABEL[productKind]} 类型的兜底策略`}
            </p>
          </div>
          <div>
            <label className="label">阶梯（hours / fee%）</label>
            {tiers.map((t, i) => (
              <div key={i} className="mt-2 flex items-center gap-2">
                <NumberInput
                  className="input w-32"
                  value={t.hoursBeforeDeparture}
                  onChange={(n) => {
                    setTiers((prev) => prev.map((x, j) => (j === i ? { ...x, hoursBeforeDeparture: n } : x)));
                  }}
                  allowNegative
                  integerOnly
                />
                <span className="text-xs text-slate-500">小时前</span>
                <NumberInput
                  min={0}
                  max={100}
                  className="input w-24"
                  value={t.feePercent}
                  onChange={(n) => {
                    setTiers((prev) => prev.map((x, j) => (j === i ? { ...x, feePercent: n } : x)));
                  }}
                />
                <span className="text-xs text-slate-500">%</span>
                <button
                  className="text-xs text-red-600 ml-auto"
                  onClick={() => setTiers((prev) => prev.filter((_, j) => j !== i))}
                >
                  删
                </button>
              </div>
            ))}
            <button
              className="mt-2 text-xs text-brand hover:underline"
              onClick={() => setTiers((prev) => [...prev, { hoursBeforeDeparture: 0, feePercent: 50 }])}
            >
              + 添加阶梯
            </button>
          </div>
        </div>
        <div className="border-t border-slate-200 px-5 py-3 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel}>取消</button>
          <button
            className="btn-primary"
            disabled={!valid}
            onClick={() =>
              onSubmit({
                productKind,
                name,
                tiers: tiers.map(draftToTier),
                scope: scope.trim() || undefined,
                isDefault: !isOverride && !existingKinds.has(productKind),
              })
            }
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
