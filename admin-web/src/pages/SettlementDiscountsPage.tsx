/**
 * 结算价立减规则 · ADMIN/STAFF — 维护代理专属、代理默认、散客三层规则。
 *
 * 规则按「档次 × 晚数 × 出发日窗口」匹配；同一层同一组键的启用窗口不能重叠，
 * 冲突信息由后端返回并原样展示给运营。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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

function todayYmd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function blankRule(kind: SettlementDiscountKind, agentId: string | null): SettlementDiscountRule {
  const today = todayYmd();
  return {
    id: '',
    kind,
    agentId: kind === 'AGENT' ? agentId : null,
    tier: TIERS[0],
    nights: 1,
    startDate: today,
    endDate: today,
    discountPerPersonCny: 0,
    isActive: true,
    note: '',
  };
}

function agentLabel(agent: AgentListItem): string {
  return agent.companyName || agent.contactName;
}

export function SettlementDiscountsPage() {
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
  const [rules, setRules] = useState<SettlementDiscountRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeTab = KIND_TABS.find((tab) => tab.kind === kind) ?? KIND_TABS[0];
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
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
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.listSettlementDiscounts(token, {
        kind,
        ...(kind === 'AGENT' ? { agentId: selectedAgentId } : {}),
      });
      setRules(result.rules);
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

  function updateRule(index: number, patch: Partial<SettlementDiscountRule>): void {
    setRules((current) => current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  }

  function addRule(): void {
    if (!canEdit || (kind === 'AGENT' && !selectedAgentId)) return;
    setRules((current) => [...current, blankRule(kind, selectedAgentId || null)]);
    setNotice(null);
  }

  async function save(): Promise<void> {
    if (!token || !canEdit || rules.length === 0) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload: SettlementDiscountWriteEntry[] = rules.map((rule) => ({
        ...(rule.id ? { id: rule.id } : {}),
        kind: rule.kind,
        ...(rule.kind === 'AGENT' && rule.agentId ? { agentId: rule.agentId } : {}),
        tier: rule.tier,
        nights: Number(rule.nights),
        startDate: rule.startDate,
        endDate: rule.endDate,
        discountPerPersonCny: Number(rule.discountPerPersonCny),
        isActive: rule.isActive,
        note: rule.note?.trim() || null,
      }));
      const result = await api.upsertSettlementDiscounts(token, payload);
      setRules(result.rules);
      setNotice(`已保存 ${result.rules.length} 条规则`);
    } catch (e: unknown) {
      // 后端的中文冲突信息直接展示，不改写其内容，方便运营按窗口拆分。
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(index: number): Promise<void> {
    if (!token || !canEdit) return;
    const rule = rules[index];
    if (!rule) return;
    if (!rule.id) {
      setRules((current) => current.filter((_, i) => i !== index));
      return;
    }
    if (!window.confirm('确认删除这条立减规则？')) return;
    setError(null);
    setNotice(null);
    try {
      await api.deleteSettlementDiscount(token, rule.id);
      setRules((current) => current.filter((_, i) => i !== index));
      setNotice('已删除');
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : '删除失败');
    }
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
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="min-w-[980px] w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-ink-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">档次</th>
                    <th className="px-3 py-2 font-medium">晚数</th>
                    <th className="px-3 py-2 font-medium">出发日窗口</th>
                    <th className="px-3 py-2 text-right font-medium">立减 ¥/人</th>
                    <th className="px-3 py-2 text-center font-medium">启用</th>
                    <th className="px-3 py-2 font-medium">备注</th>
                    {canEdit && <th className="px-3 py-2 text-right font-medium">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule, index) => (
                    <tr key={rule.id || `new-${index}`} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2">
                        <select
                          className="input min-w-[120px]"
                          value={rule.tier}
                          onChange={(e) => updateRule(index, { tier: e.target.value as SettlementTier })}
                          disabled={!canEdit}
                        >
                          {TIERS.map((tier) => <option key={tier} value={tier}>{TIER_LABELS[tier]}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className="input w-20"
                          value={rule.nights}
                          onChange={(e) => updateRule(index, { nights: Number(e.target.value) })}
                          disabled={!canEdit}
                        >
                          {NIGHTS.map((nights) => <option key={nights} value={nights}>{nights}晚</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <input
                            type="date"
                            className="input w-[145px]"
                            value={rule.startDate}
                            onChange={(e) => updateRule(index, { startDate: e.target.value })}
                            disabled={!canEdit}
                          />
                          <span className="text-ink-muted">至</span>
                          <input
                            type="date"
                            className="input w-[145px]"
                            value={rule.endDate}
                            onChange={(e) => updateRule(index, { endDate: e.target.value })}
                            disabled={!canEdit}
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={1}
                          step={1}
                          className="input w-28 text-right tabular-nums"
                          value={rule.discountPerPersonCny || ''}
                          onChange={(e) => updateRule(index, { discountPerPersonCny: Number(e.target.value) })}
                          disabled={!canEdit}
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-indigo-600"
                          checked={rule.isActive}
                          onChange={(e) => updateRule(index, { isActive: e.target.checked })}
                          disabled={!canEdit}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className="input min-w-[190px]"
                          maxLength={200}
                          value={rule.note ?? ''}
                          onChange={(e) => updateRule(index, { note: e.target.value })}
                          disabled={!canEdit}
                          placeholder="选填"
                        />
                      </td>
                      {canEdit && (
                        <td className="px-3 py-2 text-right">
                          <button type="button" className="text-xs font-medium text-rose-600 hover:text-rose-800" onClick={() => void removeRule(index)}>
                            删除
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {rules.length === 0 && (
                    <tr>
                      <td colSpan={canEdit ? 7 : 6} className="px-4 py-10 text-center text-sm text-ink-muted">暂无规则</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {canEdit && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" className="btn-secondary text-sm" onClick={addRule} disabled={kind === 'AGENT' && !selectedAgentId}>
                  + 新增规则
                </button>
                <button type="button" className="btn-primary text-sm" onClick={() => void save()} disabled={saving || rules.length === 0}>
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
