/**
 * 订单详情里两块「财务/出纳用」区域：
 *   1. 预期到账金额（出纳填，admin 可锁定后非 admin 改不动）
 *   2. 订单杂项成本（导游/赠送/手续费/其他 — 财务录入，进毛利核算）
 *
 * 权限：仅 ADMIN/STAFF 看；AGENT 完全隐藏。
 * 后端契约见 admin-web/src/lib/api.ts 的对应方法。
 */
import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type OrderCostCategory,
  type OrderCostItem,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from './NumberInput';

const CATEGORY_LABEL: Record<OrderCostCategory, string> = {
  GUIDE_SERVICE: '导游服务费',
  COMP_GIFT: '赠送费用',
  HANDLING_FEE: '手续费（收款/汇款结算）',
  OPERATION_FEE: '操作费（每单固定 ¥20）',
  OTHER: '其他',
};

const CATEGORY_OPTIONS: OrderCostCategory[] = [
  'GUIDE_SERVICE',
  'COMP_GIFT',
  'HANDLING_FEE',
  'OPERATION_FEE',
  'OTHER',
];

interface OrderFinanceSectionProps {
  orderId: string;
  initialExpectedAmountCny: string | null | undefined;
  initialExpectedAmountLocked: boolean | undefined;
  /** 任一字段保存成功后调一次，父级可借此刷新订单列表/详情。 */
  onChanged?: () => void;
}

export function OrderFinanceSection({
  orderId,
  initialExpectedAmountCny,
  initialExpectedAmountLocked,
  onChanged,
}: OrderFinanceSectionProps) {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const role = user?.role;

  // AGENT / CUSTOMER 完全不展示此 section
  if (role !== 'ADMIN' && role !== 'STAFF') return null;

  return (
    <section className="space-y-4">
      <ExpectedAmountCard
        token={token}
        orderId={orderId}
        isAdmin={role === 'ADMIN'}
        initialAmountCny={initialExpectedAmountCny}
        initialLocked={initialExpectedAmountLocked}
        onChanged={onChanged}
      />
      <CostItemsCard token={token} orderId={orderId} onChanged={onChanged} />
    </section>
  );
}

// ── 1. 预期到账金额 ────────────────────────────────────────────────
function ExpectedAmountCard({
  token,
  orderId,
  isAdmin,
  initialAmountCny,
  initialLocked,
  onChanged,
}: {
  token: string;
  orderId: string;
  isAdmin: boolean;
  initialAmountCny: string | null | undefined;
  initialLocked: boolean | undefined;
  onChanged?: () => void;
}) {
  const parseAmt = (v: string | number | null | undefined): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const [amount, setAmount] = useState<number | null>(parseAmt(initialAmountCny));
  const [locked, setLocked] = useState<boolean>(Boolean(initialLocked));
  const [loading, setLoading] = useState<boolean>(
    initialAmountCny === undefined || initialLocked === undefined,
  );
  const [saving, setSaving] = useState(false);
  const [lockToggling, setLockToggling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // 列表接口可能没带 expected* 字段；缺时拉一次详情补齐。
  useEffect(() => {
    if (!token) return;
    if (initialAmountCny !== undefined && initialLocked !== undefined) {
      setAmount(parseAmt(initialAmountCny));
      setLocked(Boolean(initialLocked));
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getOrder(token, orderId)
      .then((r) => {
        if (cancelled) return;
        setAmount(parseAmt(r.order.expectedAmountCny ?? null));
        setLocked(Boolean(r.order.expectedAmountLocked));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr(e instanceof ApiError ? e.message : '加载预期到账金额失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 仅依赖 token/orderId，初始字段只在 mount/订单切换时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, orderId]);

  const inputDisabled = saving || (locked && !isAdmin);

  async function save() {
    if (!token || saving) return;
    setErr(null);
    setOk(null);
    setSaving(true);
    try {
      const res = await api.setExpectedAmount(token, orderId, amount);
      setAmount(res.expectedAmountCny);
      setLocked(res.expectedAmountLocked);
      setOk('已保存');
      onChanged?.();
      window.setTimeout(() => setOk(null), 1500);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function toggleLock() {
    if (!token || lockToggling) return;
    setErr(null);
    setOk(null);
    setLockToggling(true);
    try {
      const res = await api.lockExpectedAmount(token, orderId, !locked);
      setLocked(res.expectedAmountLocked);
      setAmount(res.expectedAmountCny);
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '切换锁定失败');
    } finally {
      setLockToggling(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">预期到账金额</h3>
        {locked ? (
          <div className="text-right">
            <span className="badge-warning">🔒 已锁定</span>
            <p className="mt-1 text-xs text-ink-muted">
              {isAdmin ? '管理员可解锁/修改；非管理员无法编辑。' : '已由管理员锁定，如需修改请联系管理员。'}
            </p>
          </div>
        ) : (
          <span className="badge-neutral">未锁定</span>
        )}
      </div>

      {err && (
        <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[180px] text-xs text-ink-muted">
          金额（¥ CNY）
          <div className="mt-1 flex items-center gap-1">
            <span className="text-sm text-ink-muted">¥</span>
            <NumberInput
              step={0.01}
              className={`input nums disabled:bg-slate-50 disabled:text-ink-muted ${err ? 'border-rose-400 bg-rose-50' : ''}`}
              value={amount}
              onChange={setAmount}
              disabled={inputDisabled || loading}
              placeholder={loading ? '加载中…' : '未设置'}
            />
          </div>
        </label>

        <button
          className="btn-primary text-sm disabled:opacity-50"
          onClick={save}
          disabled={inputDisabled || loading}
        >
          {saving ? '保存中…' : '保存'}
        </button>

        {isAdmin && (
          <button
            className="btn-secondary text-sm"
            onClick={toggleLock}
            disabled={lockToggling || loading}
            title={locked ? '解锁后出纳可改' : '锁定后非 admin 无法修改'}
          >
            {lockToggling ? '处理中…' : locked ? '🔓 解锁' : '🔒 锁定'}
          </button>
        )}

        {ok && <span className="text-xs font-medium text-emerald-700">{ok}</span>}
      </div>

      <p className="mt-2 text-xs text-ink-muted">
        出纳填客户应付到账金额；admin 锁定后非管理员无法修改。
      </p>
    </div>
  );
}

// ── 2. 订单杂项成本 ────────────────────────────────────────────────
type DraftItem = {
  category: OrderCostCategory;
  amount: number | null;
  note: string;
};

const EMPTY_DRAFT: DraftItem = { category: 'GUIDE_SERVICE', amount: null, note: '' };

function CostItemsCard({
  token,
  orderId,
  onChanged,
}: {
  token: string;
  orderId: string;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<OrderCostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 新增表单 inline 行
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState<DraftItem>(EMPTY_DRAFT);
  const [addSubmitting, setAddSubmitting] = useState(false);

  // 编辑中行
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DraftItem>(EMPTY_DRAFT);
  const [editSubmitting, setEditSubmitting] = useState(false);

  // 删除中行
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .listOrderCostItems(token, orderId)
      .then((r) => {
        if (cancelled) return;
        setItems(r.items);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr(e instanceof ApiError ? e.message : '加载杂项成本失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, orderId]);

  async function addItem() {
    if (!token || addSubmitting) return;
    if (draft.amount === null || !(draft.amount > 0)) {
      setErr('金额需为正数');
      return;
    }
    setErr(null);
    setAddSubmitting(true);
    try {
      const r = await api.createOrderCostItem(token, orderId, {
        category: draft.category,
        amountCny: draft.amount,
        note: draft.note.trim() || null,
      });
      setItems((prev) => [...prev, r.item]);
      setDraft(EMPTY_DRAFT);
      setShowAdd(false);
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '新增失败');
    } finally {
      setAddSubmitting(false);
    }
  }

  function startEdit(item: OrderCostItem) {
    setEditingId(item.id);
    setEditDraft({
      category: item.category,
      amount: Number(item.amountCny),
      note: item.note ?? '',
    });
    setErr(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(EMPTY_DRAFT);
  }

  async function saveEdit(id: string) {
    if (!token || editSubmitting) return;
    if (editDraft.amount === null || !(editDraft.amount > 0)) {
      setErr('金额需为正数');
      return;
    }
    setErr(null);
    setEditSubmitting(true);
    try {
      const r = await api.updateOrderCostItem(token, id, {
        category: editDraft.category,
        amountCny: editDraft.amount,
        note: editDraft.note.trim() || null,
      });
      setItems((prev) => prev.map((it) => (it.id === id ? r.item : it)));
      setEditingId(null);
      setEditDraft(EMPTY_DRAFT);
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setEditSubmitting(false);
    }
  }

  async function removeItem(id: string) {
    if (!token || deletingId) return;
    if (!window.confirm('确认删除这条杂项成本？')) return;
    setErr(null);
    setDeletingId(id);
    try {
      await api.deleteOrderCostItem(token, id);
      setItems((prev) => prev.filter((it) => it.id !== id));
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      setDeletingId(null);
    }
  }

  const totalCny = items.reduce((sum, it) => sum + Number(it.amountCny), 0);

  return (
    <div className="card p-0">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-ink">
          订单杂项成本
          <span className="ml-2 text-xs font-normal text-ink-muted">
            导游 / 赠送 / 手续费 / 操作费 / 其他
          </span>
        </h3>
        <div className="flex items-center gap-2 text-xs text-ink-soft">
          {!loading && <span className="nums">合计 ¥{totalCny.toLocaleString()}</span>}
        </div>
      </div>

      {err && (
        <div className="mx-4 mt-3 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>
      )}

      <div className="overflow-x-auto">
        <table className="table-admin">
          <thead>
            <tr>
              <th className="text-left">分类</th>
              <th className="text-left">金额 (¥)</th>
              <th className="text-left">备注</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-xs text-ink-muted">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && items.length === 0 && !showAdd && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-xs text-ink-muted">
                  暂无杂项成本，点下方「+ 新增」添加
                </td>
              </tr>
            )}
            {!loading &&
              items.map((it) => {
                const isEditing = editingId === it.id;
                if (isEditing) {
                  return (
                    <tr key={it.id} className="bg-amber-50/40">
                      <td>
                        <CategorySelect
                          value={editDraft.category}
                          onChange={(c) => setEditDraft((d) => ({ ...d, category: c }))}
                        />
                      </td>
                      <td>
                        <NumberInput
                          step={0.01}
                          className={`input nums w-32 ${
                            err === '金额需为正数' && !(editDraft.amount !== null && editDraft.amount > 0)
                              ? 'border-rose-400 bg-rose-50'
                              : ''
                          }`}
                          value={editDraft.amount}
                          onChange={(n) => setEditDraft((d) => ({ ...d, amount: n }))}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          value={editDraft.note}
                          onChange={(e) => setEditDraft((d) => ({ ...d, note: e.target.value }))}
                          placeholder="选填"
                        />
                      </td>
                      <td className="text-right">
                        <div className="flex justify-end gap-1.5">
                          <button
                            className="btn-primary px-2.5 py-1 text-xs"
                            onClick={() => saveEdit(it.id)}
                            disabled={editSubmitting}
                          >
                            {editSubmitting ? '保存中…' : '保存'}
                          </button>
                          <button
                            className="btn-secondary px-2.5 py-1 text-xs"
                            onClick={cancelEdit}
                            disabled={editSubmitting}
                          >
                            取消
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={it.id}>
                    <td className="text-ink">{CATEGORY_LABEL[it.category]}</td>
                    <td className="nums font-medium text-ink">
                      ¥{Number(it.amountCny).toLocaleString()}
                    </td>
                    <td className="text-ink-muted">{it.note || '—'}</td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <button
                          className="btn-secondary px-2.5 py-1 text-xs"
                          onClick={() => startEdit(it)}
                          disabled={Boolean(editingId) || deletingId === it.id}
                        >
                          改
                        </button>
                        <button
                          className="btn-ghost px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                          onClick={() => removeItem(it.id)}
                          disabled={Boolean(editingId) || deletingId === it.id}
                        >
                          {deletingId === it.id ? '删除中…' : '删'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            {showAdd && (
              <tr className="bg-emerald-50/40">
                <td>
                  <CategorySelect
                    value={draft.category}
                    onChange={(c) => setDraft((d) => ({ ...d, category: c }))}
                  />
                </td>
                <td>
                  <NumberInput
                    step={0.01}
                    className={`input nums w-32 ${
                      err === '金额需为正数' && !(draft.amount !== null && draft.amount > 0)
                        ? 'border-rose-400 bg-rose-50'
                        : ''
                    }`}
                    value={draft.amount}
                    onChange={(n) => setDraft((d) => ({ ...d, amount: n }))}
                    placeholder="0.00"
                  />
                </td>
                <td>
                  <input
                    className="input"
                    value={draft.note}
                    onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                    placeholder="选填"
                  />
                </td>
                <td className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <button
                      className="btn-primary px-2.5 py-1 text-xs"
                      onClick={addItem}
                      disabled={addSubmitting}
                    >
                      {addSubmitting ? '保存中…' : '保存'}
                    </button>
                    <button
                      className="btn-secondary px-2.5 py-1 text-xs"
                      onClick={() => {
                        setShowAdd(false);
                        setDraft(EMPTY_DRAFT);
                      }}
                      disabled={addSubmitting}
                    >
                      取消
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!showAdd && (
        <div className="border-t border-slate-200 px-4 py-2.5">
          <button
            className="text-sm font-medium text-brand hover:text-brand-dark"
            onClick={() => {
              setShowAdd(true);
              setDraft(EMPTY_DRAFT);
              setErr(null);
            }}
          >
            + 新增
          </button>
        </div>
      )}
    </div>
  );
}

function CategorySelect({
  value,
  onChange,
}: {
  value: OrderCostCategory;
  onChange: (c: OrderCostCategory) => void;
}) {
  return (
    <select
      className="input"
      value={value}
      onChange={(e) => onChange(e.target.value as OrderCostCategory)}
    >
      {CATEGORY_OPTIONS.map((c) => (
        <option key={c} value={c}>
          {CATEGORY_LABEL[c]}
        </option>
      ))}
    </select>
  );
}
