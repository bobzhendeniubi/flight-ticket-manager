/**
 * 财务账本 · ADMIN-only
 *
 * 数据源：backend/src/modules/finances/costs-data.ts
 *        ← 由 scripts/build-presentation/build_costs_json.py 从
 *        docs/finances/COSTS.xlsx 生成
 *
 * 更新流程：
 *   1. 编辑 docs/finances/COSTS.xlsx
 *   2. python3 scripts/build-presentation/build_costs_json.py
 *   3. commit + 重 deploy backend
 *   4. 这个页面自动看到新数据
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type CostsData } from '../lib/api';
import { useAuth } from '../stores/auth';

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function fmtCny(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}

type Tab = 'summary' | 'detail' | 'monthly' | 'unitEcon';

export function FinancesPage() {
  const tokens = useAuth((s) => s.tokens);
  const [data, setData] = useState<CostsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('summary');

  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    api
      .getFinances(tokens.accessToken)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tokens?.accessToken]);

  if (loading) {
    return <div className="rounded-md bg-slate-50 p-6 text-center text-slate-500">加载中…</div>;
  }
  if (error) {
    return <div className="rounded-md bg-red-50 p-6 text-sm text-red-700">❌ {error}</div>;
  }
  if (!data) return null;

  return (
    <div className="space-y-5">
      <section>
        <h1 className="text-2xl font-bold text-slate-900">财务账本</h1>
        <p className="mt-1 text-sm text-slate-600">
          {data.title} · 数据截至 <span className="font-mono">{data.asOf}</span>
        </p>
        <p className="mt-1 text-xs text-slate-400">
          ⚠ 财务数据敏感，访问会记录到审计日志 · 数据源 <span className="font-mono">docs/finances/COSTS.xlsx</span>
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <KpiCard label="累计已花" value={fmtUsd(data.totalUsd)} sub="开发期 (4 月-5 月)" tone="brand" />
        <KpiCard
          label="开发外包占比"
          value={
            data.categories[0] && data.totalUsd
              ? `${Math.round((data.categories[0].usd / data.totalUsd) * 100)}%`
              : '—'
          }
          sub={`${data.categories[0]?.label ?? ''} = ${fmtUsd(data.categories[0]?.usd ?? 0)}`}
          tone="amber"
        />
        <KpiCard
          label="AI 总投入"
          value={fmtUsd(
            data.categories
              .filter((c) => /claude|openai|ai/i.test(c.label))
              .reduce((s, c) => s + c.usd, 0),
          )}
          sub="Claude Code + OpenAI"
          tone="indigo"
        />
        <KpiCard
          label="基建硬支出"
          value={fmtUsd(
            data.categories
              .filter((c) => /服务器|域名|github|设计|杂项/i.test(c.label))
              .reduce((s, c) => s + c.usd, 0),
          )}
          sub="服务器 + 域名 + CI + 设计 + 杂项"
          tone="slate"
        />
      </section>

      <section>
        <div className="border-b border-slate-200">
          <nav className="flex gap-1">
            <TabBtn active={tab === 'summary'} onClick={() => setTab('summary')}>
              汇总（{data.categories.length} 类）
            </TabBtn>
            <TabBtn active={tab === 'detail'} onClick={() => setTab('detail')}>
              支出明细（{data.detail.rows.filter((r) => !r.isSection).length} 笔）
            </TabBtn>
            <TabBtn active={tab === 'monthly'} onClick={() => setTab('monthly')}>
              月成本预估
            </TabBtn>
            <TabBtn active={tab === 'unitEcon'} onClick={() => setTab('unitEcon')}>
              单位经济学
            </TabBtn>
          </nav>
        </div>

        <div className="mt-4">
          {tab === 'summary' && <SummaryTab data={data} />}
          {tab === 'detail' && <DetailTab data={data} />}
          {tab === 'monthly' && <MonthlyTab data={data} />}
          {tab === 'unitEcon' && <UnitEconTab data={data} />}
        </div>
      </section>
    </div>
  );
}

function SummaryTab({ data }: { data: CostsData }) {
  return (
    <div className="card p-0 overflow-hidden">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3 text-left">类别</th>
            <th className="px-4 py-3 text-right">金额 (USD)</th>
            <th className="px-4 py-3 text-right">占比</th>
            <th className="px-4 py-3 text-left">说明</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.categories.map((c) => {
            const pct = data.totalUsd ? (c.usd / data.totalUsd) * 100 : 0;
            return (
              <tr key={c.label} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">{c.label}</td>
                <td className="px-4 py-3 text-right font-mono">{fmtUsd(c.usd)}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-20 h-1.5 bg-slate-100 rounded overflow-hidden">
                      <div className="h-full bg-brand" style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                    <span className="text-xs text-slate-500 w-10 text-right">{pct.toFixed(1)}%</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-slate-600">{c.note}</td>
              </tr>
            );
          })}
          <tr className="bg-amber-50 font-semibold">
            <td className="px-4 py-3 text-slate-900">合计（已花）</td>
            <td className="px-4 py-3 text-right font-mono text-slate-900">{fmtUsd(data.totalUsd)}</td>
            <td className="px-4 py-3 text-right">100%</td>
            <td className="px-4 py-3 text-xs text-slate-500">截至 {data.asOf}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function DetailTab({ data }: { data: CostsData }) {
  return (
    <div className="card p-0 overflow-hidden">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left w-24">日期</th>
            <th className="px-3 py-2 text-left">类别</th>
            <th className="px-3 py-2 text-left">供应商 / 项目</th>
            <th className="px-3 py-2 text-right w-24">金额</th>
            <th className="px-3 py-2 text-left">具体买了什么</th>
            <th className="px-3 py-2 text-left w-16">工时</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.detail.rows.map((r, i) => {
            if (r.isSection) {
              return (
                <tr key={i}>
                  <td colSpan={6} className="px-3 py-2 text-xs font-semibold italic text-slate-700 bg-amber-50">
                    {r.label}
                  </td>
                </tr>
              );
            }
            return (
              <tr key={i} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.date}</td>
                <td className="px-3 py-2">{r.category}</td>
                <td className="px-3 py-2 text-slate-700">{r.vendor}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">{fmtUsd(r.usd ?? 0)}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{r.what}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.hours}</td>
              </tr>
            );
          })}
          <tr className="bg-amber-100 font-semibold">
            <td colSpan={3} className="px-3 py-2 text-slate-900">═══ 合计 ═══</td>
            <td className="px-3 py-2 text-right font-mono text-slate-900">{fmtUsd(data.detail.totalUsd)}</td>
            <td colSpan={2} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MonthlyTab({ data }: { data: CostsData }) {
  return (
    <div className="card p-0 overflow-hidden">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left">类别</th>
            <th className="px-3 py-2 text-right w-32">A 测试期</th>
            <th className="px-3 py-2 text-right w-36">B 公测期 (~500)</th>
            <th className="px-3 py-2 text-right w-36">C 稳定期 (~5000)</th>
            <th className="px-3 py-2 text-left">说明</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.monthly.rows.map((r) => (
            <tr key={r.category} className="hover:bg-slate-50">
              <td className="px-3 py-2 font-medium">{r.category}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtUsd(r.testing)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtUsd(r.beta)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtUsd(r.stable)}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{r.note}</td>
            </tr>
          ))}
          <tr className="bg-amber-50 font-semibold">
            <td className="px-3 py-2">月成本合计</td>
            <td className="px-3 py-2 text-right font-mono">{fmtUsd(data.monthly.totals.testing)}</td>
            <td className="px-3 py-2 text-right font-mono">{fmtUsd(data.monthly.totals.beta)}</td>
            <td className="px-3 py-2 text-right font-mono">{fmtUsd(data.monthly.totals.stable)}</td>
            <td className="px-3 py-2" />
          </tr>
          <tr className="text-xs text-slate-500">
            <td className="px-3 py-2 italic">× 12 月（年）</td>
            <td className="px-3 py-2 text-right font-mono">{fmtUsd(data.monthly.totals.testing * 12)}</td>
            <td className="px-3 py-2 text-right font-mono">{fmtUsd(data.monthly.totals.beta * 12)}</td>
            <td className="px-3 py-2 text-right font-mono">{fmtUsd(data.monthly.totals.stable * 12)}</td>
            <td className="px-3 py-2" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function UnitEconTab({ data }: { data: CostsData }) {
  return (
    <div className="card p-0 overflow-hidden">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left">阶段</th>
            <th className="px-3 py-2 text-right">月单量</th>
            <th className="px-3 py-2 text-right">客单价</th>
            <th className="px-3 py-2 text-right">月 GMV</th>
            <th className="px-3 py-2 text-right">月毛利 (¥)</th>
            <th className="px-3 py-2 text-right">月毛利 ($)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.unitEcon.stages.map((s, i) => (
            <tr key={i} className="hover:bg-slate-50">
              <td className="px-3 py-2 font-medium">{s.stage}</td>
              <td className="px-3 py-2 text-right font-mono">{s.orders.toLocaleString()}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtCny(s.aovCny)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtCny(s.gmvCny)}</td>
              <td className="px-3 py-2 text-right font-mono text-emerald-700 font-semibold">{fmtCny(s.profitCny)}</td>
              <td className="px-3 py-2 text-right font-mono text-emerald-700 font-semibold">{fmtUsd(s.profitUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-3 text-xs text-slate-500 italic border-t border-slate-100">
        结论：单位经济学健康（毛利率 ~8%，覆盖比 4-30×）。关键不是控成本，是订单量做起来。
      </p>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'brand' | 'amber' | 'indigo' | 'slate';
}) {
  const bar = { brand: 'bg-brand', amber: 'bg-amber-500', indigo: 'bg-indigo-500', slate: 'bg-slate-500' }[tone];
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2">
        <span className={`h-8 w-1 rounded ${bar}`} />
        <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      </div>
      <p className="mt-1.5 text-2xl font-bold text-slate-900">{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm border-b-2 transition ${
        active
          ? 'border-brand text-brand font-medium'
          : 'border-transparent text-slate-600 hover:text-brand hover:border-brand/30'
      }`}
    >
      {children}
    </button>
  );
}
