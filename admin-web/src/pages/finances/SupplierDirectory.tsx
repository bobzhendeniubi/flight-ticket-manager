/**
 * 供应商主数据 —— 「供应商应付」页签上半截。
 *
 * 回答的是「这笔钱付给谁」。它**不参与任何成本计算**：毛利照旧由各产品自己的成本字段算，
 * 这里建一家供应商、改个联系人，报表上的数字一分不动。
 *
 * 停用而不是删除：账单挂着的供应商删了，历史账就成了无主账。停用的沉底但仍列出来
 * （历史账要点得进去），只是不能再挂新产品、不能再开新账单。
 */
import { useCallback, useState } from 'react';
import { ApiError } from '../../lib/api';
import {
  SUPPLIER_TYPES,
  SUPPLIER_TYPE_LABEL,
  supplierPayablesApi,
  type Supplier,
  type SupplierType,
  type SupplierWriteInput,
} from '../../lib/payablesApi';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';

export interface SupplierDirectoryProps {
  token: string;
  suppliers: Supplier[];
  loading: boolean;
  error: string | null;
  /** 建 / 改完让父级重新拉一遍——账单筛选里的供应商下拉要跟着变 */
  onChanged: () => void | Promise<void>;
}

export function SupplierDirectory({
  token,
  suppliers,
  loading,
  error,
  onChanged,
}: SupplierDirectoryProps) {
  const [open, setOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<'' | SupplierType>('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);

  const visible = suppliers.filter((s) => {
    if (typeFilter && s.type !== typeFilter) return false;
    if (!showInactive && !s.isActive) return false;
    return true;
  });
  const inactiveCount = suppliers.filter((s) => !s.isActive).length;

  return (
    <section className="rounded-xl border border-slate-200 bg-surface shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5">
        <button
          type="button"
          className="flex items-center gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Icon name="chevronRight" className={open ? 'rotate-90 transition' : 'transition'} />
          <span>
            <span className="section-title">供应商</span>
            <span className="ml-2 text-xs text-ink-muted">
              共 {suppliers.length} 家{inactiveCount > 0 ? `（含 ${inactiveCount} 家已停用）` : ''}
            </span>
          </span>
        </button>
        <button type="button" className="btn-secondary text-xs" onClick={() => setEditing('new')}>
          <Icon name="plus" /> 新建供应商
        </button>
      </header>

      {open && (
        <div className="border-t border-slate-200 px-5 py-4">
          <p className="mb-3 text-xs text-ink-muted">
            供应商只回答「钱付给谁」，不参与成本计算——建一家、改个联系人，毛利报表一分不动。
            用不上的供应商请「停用」而不是删除，否则历史账单会变成无主账。
          </p>

          <div className="mb-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="label" htmlFor="sup-type">
                类型
              </label>
              <select
                id="sup-type"
                className="input py-1.5"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as '' | SupplierType)}
              >
                <option value="">全部</option>
                {SUPPLIER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {SUPPLIER_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-1.5 pb-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              显示已停用
            </label>
          </div>

          {error && (
            <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
          )}

          <div className="overflow-x-auto">
            <table className="table-admin">
              <thead>
                <tr>
                  <th>供应商</th>
                  <th>类型</th>
                  <th>结算币种</th>
                  <th>联系人</th>
                  <th className="text-right">已挂产品</th>
                  <th>状态</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-ink-muted">
                      加载中…
                    </td>
                  </tr>
                )}
                {!loading && visible.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-ink-muted">
                      还没有供应商——先建一家，才能给它开应付账单
                    </td>
                  </tr>
                )}
                {visible.map((s) => {
                  const linked =
                    s.linkedCounts.hotels + s.linkedCounts.visas + s.linkedCounts.flights;
                  return (
                    <tr key={s.id}>
                      <td className="font-medium text-ink">{s.name}</td>
                      <td>{s.typeLabel}</td>
                      <td className="nums">{s.currency}</td>
                      <td className="text-xs">
                        {s.contactName ?? '—'}
                        {s.contactPhone ? ` · ${s.contactPhone}` : ''}
                      </td>
                      <td className="text-right text-xs nums">
                        {linked === 0 ? (
                          <span className="text-amber-700">未挂产品</span>
                        ) : (
                          <span
                            title={`酒店 ${s.linkedCounts.hotels} · 签证 ${s.linkedCounts.visas} · 航班 ${s.linkedCounts.flights}`}
                          >
                            {linked}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={s.isActive ? 'badge-success' : 'badge-neutral'}>
                          {s.isActive ? '启用' : '已停用'}
                        </span>
                      </td>
                      <td className="text-right">
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => setEditing(s)}
                        >
                          编辑
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-ink-muted">
            「已挂产品」= 挂在这家名下的酒店 / 签证产品 / 航班条数。对账要靠它把系统侧成本捞出来，
            显示「未挂产品」的供应商，对账多半会给出「无系统侧口径」。
          </p>
        </div>
      )}

      {editing && (
        <SupplierFormModal
          token={token}
          supplier={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={async () => {
            setEditing(null);
            await onChanged();
          }}
        />
      )}
    </section>
  );
}

function SupplierFormModal({
  token,
  supplier,
  onClose,
  onDone,
}: {
  token: string;
  supplier: Supplier | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [type, setType] = useState<SupplierType>(supplier?.type ?? 'HOTEL');
  const [name, setName] = useState(supplier?.name ?? '');
  const [currency, setCurrency] = useState(supplier?.currency ?? 'CNY');
  const [contactName, setContactName] = useState(supplier?.contactName ?? '');
  const [contactPhone, setContactPhone] = useState(supplier?.contactPhone ?? '');
  const [note, setNote] = useState(supplier?.note ?? '');
  const [isActive, setIsActive] = useState(supplier?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async (): Promise<void> => {
    if (saving) return;
    if (!name.trim()) {
      setErr('供应商名称不能为空');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body: SupplierWriteInput = {
        type,
        name: name.trim(),
        currency: currency.trim().toUpperCase() || 'CNY',
        contactName: contactName.trim() || null,
        contactPhone: contactPhone.trim() || null,
        note: note.trim() || null,
        isActive,
      };
      if (supplier) await supplierPayablesApi.updateSupplier(token, supplier.id, body);
      else await supplierPayablesApi.createSupplier(token, body);
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [
    saving,
    name,
    type,
    currency,
    contactName,
    contactPhone,
    note,
    isActive,
    supplier,
    token,
    onDone,
  ]);

  return (
    <Modal
      open
      onClose={onClose}
      title={supplier ? `编辑供应商 · ${supplier.name}` : '新建供应商'}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void submit()}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="sup-form-type">
              类型 *
            </label>
            <select
              id="sup-form-type"
              className="input"
              value={type}
              onChange={(e) => setType(e.target.value as SupplierType)}
            >
              {SUPPLIER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SUPPLIER_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-muted">
              类型决定它能挂哪类产品，也决定对账时拿哪套系统侧口径来比。
            </p>
          </div>
          <div>
            <label className="label" htmlFor="sup-form-currency">
              结算币种
            </label>
            <input
              id="sup-form-currency"
              className="input uppercase"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              placeholder="CNY"
            />
            <p className="mt-1 text-xs text-ink-muted">
              开账单时的默认币种，单张账单仍可另填。
            </p>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="sup-form-name">
            供应商名称 *
          </label>
          <input
            id="sup-form-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：岘港 XX 酒店（地接）"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="sup-form-contact">
              联系人
            </label>
            <input
              id="sup-form-contact"
              className="input"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="sup-form-phone">
              联系电话
            </label>
            <input
              id="sup-form-phone"
              className="input"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="sup-form-note">
            备注
          </label>
          <input
            id="sup-form-note"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：月结 30 天，账单每月 5 号发过来"
          />
        </div>

        {supplier && (
          <label className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-soft">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span>
              启用。取消勾选 = 停用：不能再挂新产品、不能再开新账单，历史账单照常查得到。
              供应商不提供删除。
            </span>
          </label>
        )}

        {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
      </div>
    </Modal>
  );
}
