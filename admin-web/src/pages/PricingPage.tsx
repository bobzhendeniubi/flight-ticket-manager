import { useMemo, useState } from 'react';
import { DEFAULT_TIERS, generatePriceHistory } from '../lib/mockData';
import { airportLabel } from '../lib/airports';

interface PricingSchedule {
  id: string;
  flightNumber: string;
  origin: string;
  dest: string;
  date: string;
  basePrice: number;
  currentMultiplier: number;
  currentTier: 'A' | 'B' | 'C' | 'D';
  loadFactor: number;
  mlDemand: number;
}

// Mock 出几个未来班次
function mockSchedules(): PricingSchedule[] {
  const today = new Date();
  const mk = (offset: number, flight: 'QH9588' | 'QH9589', base: number): PricingSchedule => {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    const dow = d.getDay();
    const tier: PricingSchedule['currentTier'] = dow === 5 || dow === 0 ? 'B' : dow === 6 ? 'A' : 'C';
    const multMap = { A: 1.5, B: 1.2, C: 1.0, D: 0.8 };
    return {
      id: `${flight}-${offset}`,
      flightNumber: flight,
      origin: flight === 'QH9588' ? 'PEK' : 'PVG',
      dest: flight === 'QH9588' ? 'PVG' : 'PEK',
      date: d.toISOString().slice(0, 10),
      basePrice: base,
      currentTier: tier,
      currentMultiplier: multMap[tier],
      loadFactor: 0.35 + (offset % 5) * 0.12,
      mlDemand: 1 + (Math.sin(offset) * 0.15 + 0.05),
    };
  };
  const out: PricingSchedule[] = [];
  for (let i = 1; i <= 7; i++) {
    out.push(mk(i, 'QH9588', 1180));
    out.push(mk(i, 'QH9589', 1280));
  }
  return out;
}

export function PricingPage() {
  const [schedules] = useState<PricingSchedule[]>(mockSchedules());
  const [selectedId, setSelectedId] = useState<string>(schedules[0]?.id ?? '');
  const selected = schedules.find((s) => s.id === selectedId) ?? schedules[0];

  const [tiers, setTiers] = useState(DEFAULT_TIERS);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const history = useMemo(
    () => (selected ? generatePriceHistory(selected.basePrice) : []),
    [selected],
  );

  if (!selected) return <div className="card text-slate-500">没有待定价的班次</div>;

  const finalPrice = Math.round(selected.basePrice * selected.currentMultiplier * selected.mlDemand);

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-bold text-slate-900">动态定价</h1>
        <p className="mt-1 text-sm text-slate-600">
          基于时段 / 上座率 / ML 需求预测的 ABCD 等级定价引擎。支持手工覆盖单班次倍率。
        </p>
      </section>

      <section className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* 班次列表 */}
        <div className="card p-0 overflow-hidden">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-medium uppercase text-slate-500">
            未来 7 天班次
          </div>
          <ul className="divide-y divide-slate-100 max-h-[560px] overflow-auto">
            {schedules.map((s) => {
              const isSel = s.id === selectedId;
              return (
                <li key={s.id}>
                  <button
                    onClick={() => setSelectedId(s.id)}
                    className={`w-full px-4 py-3 text-left transition ${
                      isSel ? 'bg-brand/10' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-900">{s.flightNumber}</span>
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tierBadgeColor(s.currentTier)}`}>
                        {s.currentTier}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-600">
                      {s.origin} → {s.dest}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-xs text-slate-500">
                      <span>{s.date}</span>
                      <span>上座率 {Math.round(s.loadFactor * 100)}%</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* 右侧详情 */}
        <div className="space-y-4">
          <div className="card">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  {selected.flightNumber} · {airportLabel(selected.origin)} → {airportLabel(selected.dest)}
                </h2>
                <p className="mt-0.5 text-sm text-slate-600">出发日期 {selected.date}</p>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">当前建议售价</div>
                <div className="text-3xl font-bold text-red-600">¥{finalPrice}</div>
                <div className="text-xs text-slate-500">基础价 ¥{selected.basePrice}</div>
              </div>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-4">
              <Metric
                label="当前等级"
                value={<span className={`rounded px-2 py-0.5 font-mono ${tierBadgeColor(selected.currentTier)}`}>{selected.currentTier}</span>}
                sub={`倍率 ×${selected.currentMultiplier.toFixed(2)}`}
              />
              <Metric
                label="上座率"
                value={`${Math.round(selected.loadFactor * 100)}%`}
                sub={selected.loadFactor > 0.7 ? '⚠ 接近满舱' : selected.loadFactor < 0.3 ? '空舱较多' : '运行正常'}
              />
              <Metric
                label="ML 需求预测"
                value={`×${selected.mlDemand.toFixed(3)}`}
                sub="Prophet 模型 · 昨晚更新"
              />
              <Metric
                label="最终售价"
                value={`¥${finalPrice}`}
                sub={`基础 × 等级 × 需求`}
              />
            </div>
          </div>

          {/* ABCD 等级配置 */}
          <div className="card">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-slate-900">ABCD 等级配置</h3>
              <button
                className="btn-primary text-sm"
                onClick={() => {
                  setSavedAt(new Date().toLocaleTimeString('zh-CN'));
                }}
              >
                保存调整
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">拖动倍率调节各等级的加价幅度，保存后对后续班次立即生效。</p>
            <div className="mt-4 space-y-4">
              {tiers.map((t, idx) => (
                <div key={t.tier} className="grid grid-cols-[auto_1fr_auto] items-center gap-4">
                  <span className={`rounded px-2 py-1 text-sm font-bold ${tierBadgeColor(t.tier)}`}>
                    {t.tier}
                  </span>
                  <div>
                    <div className="font-medium text-slate-900">{t.label}</div>
                    <div className="text-xs text-slate-500">{t.description}</div>
                    <input
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.05}
                      value={t.multiplier}
                      onChange={(e) => {
                        const next = [...tiers];
                        next[idx] = { ...t, multiplier: Number(e.target.value) };
                        setTiers(next);
                        setSavedAt(null);
                      }}
                      className="mt-2 w-full"
                    />
                  </div>
                  <div className="w-20 text-right">
                    <div className="text-lg font-bold text-slate-900">×{t.multiplier.toFixed(2)}</div>
                    <div className="text-xs text-slate-500">¥{Math.round(selected.basePrice * t.multiplier)}</div>
                  </div>
                </div>
              ))}
            </div>
            {savedAt && (
              <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
                ✅ 已保存（demo）· {savedAt}
              </div>
            )}
          </div>

          {/* 价格历史 */}
          <div className="card">
            <h3 className="font-semibold text-slate-900">近 14 天实际售价</h3>
            <p className="mt-1 text-xs text-slate-500">每个柱子代表一天的平均售价，颜色对应触发的等级。</p>
            <div className="mt-4 flex items-end gap-1 h-40">
              {history.map((h) => {
                const max = Math.max(...history.map((x) => x.price));
                return (
                  <div key={h.date} className="flex-1 flex flex-col items-center gap-1">
                    <div className="text-[10px] text-slate-500">{h.price}</div>
                    <div
                      className={`w-full rounded-t ${tierBarColor(h.tier)}`}
                      style={{ height: `${(h.price / max) * 80}%` }}
                      title={`${h.date} · ¥${h.price} · ${h.tier}`}
                    />
                    <div className="text-[9px] text-slate-500">{h.date.slice(5)}</div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex gap-3 text-xs">
              {(['A', 'B', 'C', 'D'] as const).map((t) => (
                <span key={t} className="flex items-center gap-1">
                  <span className={`inline-block h-3 w-3 rounded ${tierBarColor(t)}`} />
                  {t} 等级
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

function tierBadgeColor(tier: 'A' | 'B' | 'C' | 'D') {
  switch (tier) {
    case 'A':
      return 'bg-red-100 text-red-700';
    case 'B':
      return 'bg-amber-100 text-amber-700';
    case 'C':
      return 'bg-blue-100 text-blue-700';
    case 'D':
      return 'bg-green-100 text-green-700';
  }
}

function tierBarColor(tier: 'A' | 'B' | 'C' | 'D') {
  switch (tier) {
    case 'A':
      return 'bg-red-400';
    case 'B':
      return 'bg-amber-400';
    case 'C':
      return 'bg-blue-400';
    case 'D':
      return 'bg-green-400';
  }
}
