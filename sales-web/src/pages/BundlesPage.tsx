/**
 * 套餐展示页 — 可配置人数 + 房间数。
 *
 * 机票：动态价 × 人数（从 /flights/search 实时拉）
 * 酒店：每晚价 × 晚数 × 房间数
 * 签证：每人价 × 人数
 * 接送：固定价（按趟，不按人头）
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { type MockBundle, type BundleItem } from '../lib/mockData';
import { api, type Bundle as ApiBundle } from '../lib/api';
import { useCart } from '../stores/cart';

function bundleApiToMock(b: ApiBundle): MockBundle {
  const items = (b.items as BundleItem[]) ?? [];
  const groundTotal = items.filter((i) => i.kind !== 'FLIGHT').reduce((s, i) => s + i.unitPrice * i.qty, 0);
  return {
    id: b.id, name: b.name, tagline: b.tagline ?? '', emoji: b.emoji ?? '🎁',
    photo: b.photo ?? '',
    items, listPrice: groundTotal, bundlePrice: groundTotal,
    groundDiscount: Number(b.groundDiscount), flightPax: b.flightPax,
    suitableFor: b.suitableFor ?? '', active: b.isActive,
  };
}

function todayISO(offset = 3) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

const KIND_LABEL: Record<BundleItem['kind'], { label: string; color: string }> = {
  FLIGHT: { label: '机票', color: 'bg-sky-100 text-sky-700' },
  HOTEL: { label: '酒店', color: 'bg-purple-100 text-purple-700' },
  TRANSFER: { label: '接送', color: 'bg-pink-100 text-pink-700' },
  VISA: { label: '签证', color: 'bg-amber-100 text-amber-700' },
};

export function BundlesPage() {
  const add = useCart((s) => s.add);
  const [bundles, setBundles] = useState<MockBundle[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.listBundles().then((r) => { if (!cancelled) setBundles(r.bundles.map(bundleApiToMock)); }).catch(() => {/* 静默 */});
    return () => { cancelled = true; };
  }, []);

  const [goDate, setGoDate] = useState(todayISO(3));
  const [returnDate, setReturnDate] = useState(todayISO(7));

  // 动态机票价（单人来回）— dateRank 不展示给客户，所以不存进 state
  const [flightPrices, setFlightPrices] = useState({
    econPerPerson: 0,
    bizPerPerson: 0,
    loaded: false,
  });

  const loadPrices = useCallback(async () => {
    try {
      const [go, ret] = await Promise.all([
        api.searchFlights({ origin: 'MFM', destination: 'DAD', date: goDate, passengers: 1 }),
        api.searchFlights({ origin: 'DAD', destination: 'MFM', date: returnDate, passengers: 1 }),
      ]);
      const goE = go.results[0]?.seatClasses.find((c) => c.cabin === 'ECONOMY');
      const retE = ret.results[0]?.seatClasses.find((c) => c.cabin === 'ECONOMY');
      const goB = go.results[0]?.seatClasses.find((c) => c.cabin === 'BUSINESS');
      const retB = ret.results[0]?.seatClasses.find((c) => c.cabin === 'BUSINESS');
      setFlightPrices({
        econPerPerson: (goE ? Number(goE.dynamicPrice) : 1480) + (retE ? Number(retE.dynamicPrice) : 1380),
        bizPerPerson: (goB ? Number(goB.dynamicPrice) : 4380) + (retB ? Number(retB.dynamicPrice) : 4280),
        loaded: true,
      });
    } catch {
      setFlightPrices({ econPerPerson: 2860, bizPerPerson: 8660, loaded: true });
    }
  }, [goDate, returnDate]);

  useEffect(() => { loadPrices(); }, [loadPrices]);

  const visible = bundles.filter((b) => b.active);

  return (
    <div className="space-y-5">
      <section className="rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 p-6 text-white">
        <h1 className="text-2xl font-bold">岘港全包套餐</h1>
        <p className="mt-1 text-sm text-emerald-50">
          来回机票 + 酒店 + 接送 + 签证一价全含。可调人数和房间数，价格实时更新。
        </p>
      </section>

      <section className="card">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className="label">去程日期</label>
            <input type="date" className="input" value={goDate} onChange={(e) => setGoDate(e.target.value)} />
          </div>
          <div>
            <label className="label">回程日期</label>
            <input type="date" className="input" value={returnDate} min={goDate} onChange={(e) => setReturnDate(e.target.value)} />
          </div>
          <div className="flex items-end">
            {flightPrices.loaded ? (
              <div className="text-sm">
                <span className="text-slate-600">
                  经济舱来回 <strong className="text-red-600">¥{flightPrices.econPerPerson.toLocaleString()}</strong>/人
                </span>
              </div>
            ) : (
              <span className="text-sm text-slate-500">加载中…</span>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        {visible.map((b) => (
          <ConfigurableBundleCard
            key={b.id}
            bundle={b}
            flightPrices={flightPrices}
            goDate={goDate}
            returnDate={returnDate}
            onAdd={(cfg) => {
              add({
                kind: 'BUNDLE',
                productId: b.id,
                name: `${b.name}（${cfg.pax}人${cfg.rooms}房 · ${goDate}→${returnDate}）`,
                description: b.tagline,
                emoji: b.emoji,
                unitPrice: cfg.total,
                qty: 1,
                meta: {
                  goDate, returnDate,
                  pax: cfg.pax, rooms: cfg.rooms,
                  flightTotal: cfg.flightTotal,
                  hotelTotal: cfg.hotelTotal,
                  otherTotal: cfg.otherTotal,
                  discount: b.groundDiscount,
                },
              });
            }}
          />
        ))}
      </section>
    </div>
  );
}

// ── 可配置套餐卡 ─────────────────────────────────────────────────

function ConfigurableBundleCard({
  bundle: b,
  flightPrices,
  goDate,
  returnDate,
  onAdd,
}: {
  bundle: MockBundle;
  flightPrices: { econPerPerson: number; bizPerPerson: number };
  goDate: string;
  returnDate: string;
  onAdd: (cfg: { pax: number; rooms: number; total: number; flightTotal: number; hotelTotal: number; otherTotal: number }) => void;
}) {
  const [pax, setPax] = useState(b.flightPax); // 出行人数（至少 1）
  const [rooms, setRooms] = useState(1); // 房间数

  const isBiz = b.items.some((i) => i.kind === 'FLIGHT' && i.productName.includes('商务'));
  const pricePerPerson = isBiz ? flightPrices.bizPerPerson : flightPrices.econPerPerson;

  // 计算每个行项的金额
  const itemRows = b.items.map((item) => {
    if (item.kind === 'FLIGHT') {
      return { ...item, computedTotal: pricePerPerson * pax, label: `来回${isBiz ? '商务' : '经济'}舱 × ${pax} 人` };
    }
    if (item.kind === 'HOTEL') {
      return { ...item, computedTotal: item.unitPrice * item.qty * rooms, label: `${item.productName}${rooms > 1 ? ` × ${rooms} 房` : ''}` };
    }
    if (item.kind === 'VISA') {
      return { ...item, computedTotal: item.unitPrice * pax, label: `${item.productName.replace(/× \d+/, `× ${pax}`)}` };
    }
    // TRANSFER — 固定价（按趟不按人头）
    return { ...item, computedTotal: item.unitPrice * item.qty, label: item.productName };
  });

  const flightTotal = itemRows.filter((r) => r.kind === 'FLIGHT').reduce((s, r) => s + r.computedTotal, 0);
  const hotelTotal = itemRows.filter((r) => r.kind === 'HOTEL').reduce((s, r) => s + r.computedTotal, 0);
  const otherTotal = itemRows.filter((r) => r.kind !== 'FLIGHT' && r.kind !== 'HOTEL').reduce((s, r) => s + r.computedTotal, 0);
  const listTotal = flightTotal + hotelTotal + otherTotal;
  const total = listTotal - b.groundDiscount;

  return (
    <article className="card overflow-hidden p-0">
      {b.photo ? (
        <div className="relative h-44 w-full overflow-hidden bg-slate-100">
          <img
            src={b.photo}
            alt={b.name}
            className="h-full w-full object-cover"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
          <span className="absolute left-3 top-3 text-3xl drop-shadow">{b.emoji}</span>
        </div>
      ) : null}
      <div className="p-5">
      <div className="flex flex-wrap items-start gap-4">
        {!b.photo && <span className="text-4xl">{b.emoji}</span>}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-slate-900">{b.name}</h3>
          </div>
          <p className="mt-0.5 text-sm text-slate-600">{b.tagline}</p>
        </div>

        {/* 人数 + 房间数 调整器 */}
        <div className="flex flex-col gap-2 items-end">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-600">出行人数</span>
            <Stepper value={pax} min={1} max={9} onChange={setPax} />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-600">房间数</span>
            <Stepper value={rooms} min={1} max={5} onChange={setRooms} />
          </div>
        </div>
      </div>

      {/* 明细 */}
      <div className="mt-4 space-y-1.5">
        {itemRows.map((r, idx) => (
          <div key={idx} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`rounded px-1.5 py-0.5 font-medium ${KIND_LABEL[r.kind].color}`}>
                {KIND_LABEL[r.kind].label}
              </span>
              <span className="text-slate-700 truncate">{r.label}</span>
            </div>
            <span className="text-slate-600 tabular-nums whitespace-nowrap">
              ¥{r.computedTotal.toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {/* 价格汇总 */}
      <div className="mt-4 rounded-md bg-slate-50 p-3">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            机票 ¥{flightTotal.toLocaleString()} + 酒店 ¥{hotelTotal.toLocaleString()} + 其他 ¥{otherTotal.toLocaleString()}
            {b.groundDiscount > 0 && ` − 让利 ¥${b.groundDiscount.toLocaleString()}`}
          </span>
        </div>
        <div className="mt-1 flex items-end justify-between">
          <div className="text-xs text-slate-500">
            {pax} 人 · {rooms} 房 · {goDate} → {returnDate}
          </div>
          <div>
            {b.groundDiscount > 0 && (
              <span className="text-xs text-slate-400 line-through mr-2">¥{listTotal.toLocaleString()}</span>
            )}
            <span className="text-2xl font-bold text-red-600">¥{total.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Link to="/cart" className="btn-secondary text-sm">查看购物车</Link>
        <button
          className="btn-primary text-sm"
          onClick={() => onAdd({ pax, rooms, total, flightTotal, hotelTotal, otherTotal })}
        >
          加入购物车
        </button>
      </div>
      </div>
    </article>
  );
}

// ── 小组件 ───────────────────────────────────────────────────────

function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-slate-300 overflow-hidden">
      <button
        type="button"
        className="px-2 py-1 hover:bg-slate-50 disabled:text-slate-300"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <span className="px-3 py-1 text-center tabular-nums min-w-[2.5rem] bg-white font-medium">
        {value}
      </span>
      <button
        type="button"
        className="px-2 py-1 hover:bg-slate-50 disabled:text-slate-300"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}

// RankBadge 已移除：dateRank A/B/C/D 是公司内部日期等级，不对客户展示
