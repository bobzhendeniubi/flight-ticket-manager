/**
 * 结算价立减规则 · ADMIN/STAFF — 维护代理专属、代理默认、散客三层规则。
 *
 * 规则按「档次 × 晚数 × 出发日窗口」匹配；同一层同一组键的启用窗口不能重叠，
 * 冲突信息由后端返回并原样展示给运营。
 *
 * 页面按晚数分区（1 晚 / 2 晚 / … 各一块）：
 *   - 晚数是分区归属，不是行内可改字段——已有行不再提供晚数下拉。
 *     扁平表时代运营想「给下一个晚数配规则」，顺手改了已有行的晚数下拉，
 *     保存即把上一晚数的规则整条覆盖掉。分区化之后这个手势不存在了。
 *   - 想换晚数 = 在目标晚数分区新增一条，再把原规则停用或删除。
 *   - 档次同理：已落库的行档次只读（后端身份列守卫也会 400 拒），新建行才可选。
 *   - 没配规则的晚数也照样渲染空分区，避免「配了 1 晚以为全配了」。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  type AgentListItem,
  type SettlementDiscountKind,
  type SettlementDiscountRule,
  type SettlementDiscountWriteEntry,
  type SettlementTier,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';
import { useConfirm } from '../components/ConfirmDialog';

const TIERS: SettlementTier[] = ['CITY_3STAR', 'CITY_4STAR', 'CITY_5STAR', 'INTL_5STAR'];
const TIER_LABELS: Record<SettlementTier, string> = {
  CITY_3STAR: '市区三星',
  CITY_4STAR: '市区四星',
  CITY_5STAR: '市区五星',
  INTL_5STAR: '国际五星',
};
const NIGHTS = [1, 2, 3, 4, 5];
const KIND_TABS: Array<{ kind: SettlementDiscountKind; label: string; hint: string }> = [
  { kind: 'AGENT', label: '代理专属', hint: '只对指定代理生效；命中后优先于代理默认规则。' },
  { kind: 'AGENT_DEFAULT', label: '代理默认', hint: '代理没有专属命中时使用；规则不绑定具体代理。' },
  { kind: 'RETAIL', label: '散客', hint: '前台套餐在 percent-off 后再按出发日命中；公开接口只返回金额。' },
];

/**
 * 编辑草稿行。与接口模型的两点差别：
 *   - discountInput 用字符串存输入框原文，新建行可以是空串（后端 zod 要求 ≥1，
 *     旧版初始 0 会让整批 $transaction 被拒且不指明是哪一行）；
 *   - rowKey 是渲染用的稳定键，新建行没有 id。
 */
interface DraftRule {
  rowKey: string;
  id: string;
  kind: SettlementDiscountKind;
  agentId: string | null;
  tier: SettlementTier;
  nights: number;
  startDate: string;
  endDate: string;
  discountInput: string;
  isActive: boolean;
  note: string;
}

function todayYmd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDraft(rule: SettlementDiscountRule): DraftRule {
  return {
    rowKey: rule.id,
    id: rule.id,
    kind: rule.kind,
    agentId: rule.agentId,
    tier: rule.tier,
    nights: rule.nights,
    startDate: rule.startDate,
    endDate: rule.endDate,
    discountInput: String(rule.discountPerPersonCny ?? ''),
    isActive: rule.isActive,
    note: rule.note ?? '',
  };
}

function blankDraft(
  kind: SettlementDiscountKind,
  agentId: string | null,
  nights: number,
  rowKey: string,
): DraftRule {
  const today = todayYmd();
  return {
    rowKey,
    id: '',
    kind,
    agentId: kind === 'AGENT' ? agentId : null,
    tier: TIERS[0],
    nights,
    startDate: today,
    endDate: today,
    discountInput: '',
    isActive: true,
    note: '',
  };
}

/** 行级校验：不合规的行在前端就拦下来，别让后端整批打回还不说是哪一行。 */
function validateDraft(draft: DraftRule): string | null {
  if (!draft.startDate || !draft.endDate) return '请填写出发日窗口的开始和结束日期';
  if (draft.startDate > draft.endDate) return '出发日窗口的结束日期不能早于开始日期';
  const raw = draft.discountInput.trim();
  if (!raw) return '请填写立减金额（¥/人）';
  const amount = Number(raw);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 1) {
    return '立减金额需为不小于 1 的整数';
  }
  return null;
}

function agentLabel(agent: AgentListItem): string {
  return agent.companyName || agent.contactName;
}

export function SettlementDiscountsPage() {
  const confirm = useConfirm();
  const confirmLockRef = useRef(false);
  const newRowSeqRef = useRef(0);
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const token = tokens?.accessToken ?? '';
  // 立减规则写权限：ADMIN 与内部岗位（STAFF）都可维护 —— 录单岗要按代理口径自己配立减，
  // 每次都绕到管理员那边会让规则永远配不齐。AGENT 进不来本页（路由级 adminOnly 已拦），
  // 故此处只区分内外部；写操作后端仍逐条落审计（UPSERT/DELETE_SETTLEMENT_DISCOUNT）。
  const canEdit = user?.role === 'ADMIN' || user?.role === 'STAFF';
  const [searchParams] = useSearchParams();

  const [kind, setKind] = useState<SettlementDiscountKind>('AGENT');
  const [selectedAgentId, setSelectedAgentId] = useState(() => searchParams.get('agentId') ?? '');
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeTab = KIND_TABS.find((tab) => tab.kind === kind) ?? KIND_TABS[0];
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const rulesByNights = useMemo(() => {
    const grouped = new Map<number, DraftRule[]>();
    for (const rule of rules) {
      const bucket = grouped.get(rule.nights);
      if (bucket) bucket.push(rule);
      else grouped.set(rule.nights, [rule]);
    }
    return grouped;
  }, [rules]);

  // 分区列表：固定 1–5 晚，外加数据里出现过的其它晚数（历史数据不至于在页面上凭空消失）。
  const nightSections = useMemo(() => {
    const all = new Set<number>(NIGHTS);
    for (const nights of rulesByNights.keys()) all.add(nights);
    return [...all].sort((a, b) => a - b);
  }, [rulesByNights]);

  const configuredNights = useMemo(
    () => NIGHTS.filter((nights) => (rulesByNights.get(nights)?.length ?? 0) > 0),
    [rulesByNights],
  );
  const missingNights = useMemo(
    () => NIGHTS.filter((nights) => (rulesByNights.get(nights)?.length ?? 0) === 0),
    [rulesByNights],
  );

  useEffect(() => {
    if (!token) return;
    api.listAgents(token)
      .then((result) => setAgents(result.agents))
      .catch(() => {
        setAgents([]);
        setError('代理列表加载失败，请刷新重试');
      });
  }, [token]);

  const load = useCallback(async () => {
    if (!token || (kind === 'AGENT' && !selectedAgentId)) {
      setRules([]);
      setRowErrors({});
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    setRowErrors({});
    try {
      const result = await api.listSettlementDiscounts(token, {
        kind,
        ...(kind === 'AGENT' ? { agentId: selectedAgentId } : {}),
      });
      setRules(result.rules.map(toDraft));
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : '立减规则加载失败');
    } finally {
      setLoading(false);
    }
  }, [kind, selectedAgentId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  function changeKind(next: SettlementDiscountKind): void {
    setKind(next);
    setError(null);
    setNotice(null);
  }

  function updateRule(rowKey: string, patch: Partial<DraftRule>): void {
    setRules((current) => current.map((rule) => (rule.rowKey === rowKey ? { ...rule, ...patch } : rule)));
    // 行一被编辑就撤掉它的红框，免得运营改完还盯着旧提示。
    setRowErrors((current) => {
      if (!current[rowKey]) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
  }

  function addRule(nights: number): void {
    if (!canEdit || (kind === 'AGENT' && !selectedAgentId)) return;
    newRowSeqRef.current += 1;
    const rowKey = `new-${newRowSeqRef.current}`;
    setRules((current) => [...current, blankDraft(kind, selectedAgentId || null, nights, rowKey)]);
    setError(null);
    setNotice(null);
  }

  async function save(): Promise<void> {
    if (!token || !canEdit || rules.length === 0) return;

    const nextRowErrors: Record<string, string> = {};
    for (const rule of rules) {
      const message = validateDraft(rule);
      if (message) nextRowErrors[rule.rowKey] = message;
    }
    const invalidCount = Object.keys(nextRowErrors).length;
    if (invalidCount > 0) {
      setRowErrors(nextRowErrors);
      setNotice(null);
      setError(`有 ${invalidCount} 行还没填完整，已在下方标红；补齐后再保存。`);
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    setRowErrors({});
    try {
      const payload: SettlementDiscountWriteEntry[] = rules.map((rule) => ({
        ...(rule.id ? { id: rule.id } : {}),
        kind: rule.kind,
        ...(rule.kind === 'AGENT' && rule.agentId ? { agentId: rule.agentId } : {}),
        tier: rule.tier,
        nights: Number(rule.nights),
        startDate: rule.startDate,
        endDate: rule.endDate,
        discountPerPersonCny: Number(rule.discountInput.trim()),
        isActive: rule.isActive,
        note: rule.note.trim() || null,
      }));
      const result = await api.upsertSettlementDiscounts(token, payload);
      const savedCount = result.rules.length;
      // 重新拉全量：只回填本次提交的行会看不到其它晚数，正是「以为只配了这些」的来源。
      await load();
      setNotice(`已保存 ${savedCount} 条规则，下方为当前范围内的全部规则`);
    } catch (e: unknown) {
      // 后端的中文冲突信息直接展示，不改写其内容，方便运营按窗口拆分。
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(rowKey: string): Promise<void> {
    if (!token || !canEdit) return;
    const rule = rules.find((item) => item.rowKey === rowKey);
    if (!rule) return;
    if (!rule.id) {
      setRules((current) => current.filter((item) => item.rowKey !== rowKey));
      return;
    }
    if (confirmLockRef.current) return;
    confirmLockRef.current = true;
    if (!(await confirm({ title: '确认删除这条立减规则？', tone: 'danger' }))) {
      confirmLockRef.current = false;
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await api.deleteSettlementDiscount(token, rule.id);
      setRules((current) => current.filter((item) => item.rowKey !== rowKey));
      setNotice('已删除');
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      confirmLockRef.current = false;
    }
  }

  const columnCount = canEdit ? 6 : 5;

  function renderSection(nights: number) {
    const sectionRules = rulesByNights.get(nights) ?? [];
    return (
      <section key={nights} className="rounded-md border border-slate-200">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">{nights} 晚</h2>
            <span
              className={
                sectionRules.length > 0
                  ? 'rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700'
                  : 'rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500'
              }
            >
              {sectionRules.length > 0 ? `${sectionRules.length} 条` : '未配置'}
            </span>
          </div>
          {canEdit && (
            <button
              type="button"
              className="btn-secondary px-2 py-1 text-xs"
              onClick={() => addRule(nights)}
              disabled={kind === 'AGENT' && !selectedAgentId}
            >
              + 新增 {nights} 晚规则
            </button>
          )}
        </header>

        {sectionRules.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-ink-muted">
            {canEdit
              ? `该晚数还没有规则，点右上角「+ 新增 ${nights} 晚规则」开始配置。`
              : '该晚数还没有规则。'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[880px] w-full text-sm">
              <thead className="bg-white text-left text-xs text-ink-muted">
                <tr className="border-b border-slate-100">
                  <th className="px-3 py-2 font-medium">档次</th>
                  <th className="px-3 py-2 font-medium">出发日窗口</th>
                  <th className="px-3 py-2 font-medium">立减 ¥/人</th>
                  <th className="px-3 py-2 text-center font-medium">启用</th>
                  <th className="px-3 py-2 font-medium">备注</th>
                  {canEdit && <th className="px-3 py-2 text-right font-medium">操作</th>}
                </tr>
              </thead>
              <tbody>
                {sectionRules.map((rule) => {
                  const rowError = rowErrors[rule.rowKey];
                  const errCls = rowError ? ' border-rose-400 ring-1 ring-rose-300' : '';
                  return (
                    <Fragment key={rule.rowKey}>
                      <tr className={`border-t border-slate-100 align-top${rowError ? ' bg-rose-50/60' : ''}`}>
                        <td className="px-3 py-2">
                          {rule.id ? (
                            // 已落库的行：档次与晚数一样是身份列，改了等于把另一条规则原地覆盖，
                            // 后端也会拒（400）。这里索性只读，换档次走「新增 + 停用原条」。
                            <span className="inline-block min-w-[120px] py-1.5 text-sm text-ink">
                              {TIER_LABELS[rule.tier]}
                            </span>
                          ) : (
                            <select
                              className="input min-w-[120px]"
                              value={rule.tier}
                              onChange={(e) => updateRule(rule.rowKey, { tier: e.target.value as SettlementTier })}
                              disabled={!canEdit}
                            >
                              {TIERS.map((tier) => <option key={tier} value={tier}>{TIER_LABELS[tier]}</option>)}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <input
                              type="date"
                              className={`input w-[145px]${errCls}`}
                              value={rule.startDate}
                              onChange={(e) => updateRule(rule.rowKey, { startDate: e.target.value })}
                              disabled={!canEdit}
                            />
                            <span className="text-ink-muted">至</span>
                            <input
                              type="date"
                              className={`input w-[145px]${errCls}`}
                              value={rule.endDate}
                              onChange={(e) => updateRule(rule.rowKey, { endDate: e.target.value })}
                              disabled={!canEdit}
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={1}
                            step={1}
                            className={`input w-28 text-right tabular-nums${errCls}`}
                            value={rule.discountInput}
                            onChange={(e) => updateRule(rule.rowKey, { discountInput: e.target.value })}
                            disabled={!canEdit}
                            placeholder="必填"
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-indigo-600"
                            checked={rule.isActive}
                            onChange={(e) => updateRule(rule.rowKey, { isActive: e.target.checked })}
                            disabled={!canEdit}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            className="input min-w-[190px]"
                            maxLength={200}
                            value={rule.note}
                            onChange={(e) => updateRule(rule.rowKey, { note: e.target.value })}
                            disabled={!canEdit}
                            placeholder="选填"
                          />
                        </td>
                        {canEdit && (
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              className="btn-ghost-danger px-2 py-1 text-xs"
                              onClick={() => void removeRule(rule.rowKey)}
                            >
                              <Icon name="trash" /> 删除
                            </button>
                          </td>
                        )}
                      </tr>
                      {rowError && (
                        <tr className="bg-rose-50/60">
                          <td colSpan={columnCount} className="px-3 pb-2 text-xs text-rose-700">
                            {rowError}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">立减规则</h1>
          <p className="page-sub">按档次、晚数与出发日窗口维护结算价立减；同组启用窗口不可重叠。</p>
        </div>
        <Link to="/settlement-rates" className="btn-secondary text-sm">查看结算价日历</Link>
      </section>

      <section className="card space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex gap-1 border-b border-slate-200">
            {KIND_TABS.map((tab) => (
              <button
                key={tab.kind}
                type="button"
                className={
                  tab.kind === kind
                    ? '-mb-px border-b-2 border-indigo-600 px-4 py-2 text-sm font-semibold text-indigo-700'
                    : '-mb-px border-b-2 border-transparent px-4 py-2 text-sm text-ink-muted hover:text-ink'
                }
                onClick={() => changeKind(tab.kind)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {kind === 'AGENT' && (
            <label className="min-w-[260px] text-xs text-ink-muted">
              指定代理
              <select
                className="input mt-1"
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                disabled={!canEdit && agents.length === 0}
              >
                <option value="">请选择代理…</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agentLabel(agent)} · {agent.contactName}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
          <span>{activeTab.hint}{selectedAgent ? ` 当前代理：${agentLabel(selectedAgent)}` : ''}</span>
          {!canEdit && <span className="rounded bg-slate-100 px-2 py-1 text-slate-600">当前为只读模式</span>}
        </div>

        <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-ink-muted ring-1 ring-slate-200">
          晚数按分区归属；已保存的规则，晚数与档次都不可再改（改了等于把另一条规则原地覆盖）。
          要换晚数或档次：在目标晚数分区「+ 新增规则」另建一条，再把原来那条停用或删除。
          金额、出发日窗口、启用状态和备注随时可改。
        </p>

        {error && <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">{error}</div>}
        {notice && <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-emerald-200">{notice}</div>}

        {kind === 'AGENT' && !selectedAgentId ? (
          <div className="rounded-md border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-ink-muted">
            请选择代理后查看或维护专属立减规则。
          </div>
        ) : loading ? (
          <div className="py-10 text-center text-sm text-ink-muted">加载中…</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-ink-muted">
                已配置晚数：{configuredNights.length > 0 ? configuredNights.map((n) => `${n}晚`).join('、') : '无'}
              </span>
              {missingNights.length > 0 && (
                <span className="rounded bg-amber-50 px-2 py-1 text-amber-700 ring-1 ring-amber-200">
                  还没配：{missingNights.map((n) => `${n}晚`).join('、')}
                </span>
              )}
            </div>

            <div className="space-y-3">
              {nightSections.map((nights) => renderSection(nights))}
            </div>

            {canEdit && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  className="btn-primary text-sm"
                  onClick={() => void save()}
                  disabled={saving || rules.length === 0}
                >
                  {saving ? '保存中…' : '批量保存'}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
