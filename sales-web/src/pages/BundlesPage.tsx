/**
 * 套餐展示页 — 含机票（动态价）+ 地面服务（静态价）。
 *
 * 机票价格从 /flights/price 实时拉取（按选定日期 + 人数），
 * 地面服务价格固定。套餐总价 = 动态机票 + 地面服务 - groundDiscount。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MOCK_BUNDLES,
  type MockBundle,
  type BundleItem,
} from '../lib/mockData';
import { api } from '../lib/api';
import { useCart } from '../stores/cart';

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
  const [selected, setSelected] = useState<MockBundle | null>(null);
  const add = useCart((s) => s.add);

  // 日期选择 → 影响机票动态价
  const [goDate, setGoDate] = useState(todayISO(3));
  const [returnDate, setReturnDate] = useState(todayISO(7));

  // 从 API 获取去回程的 经济/商务 动态价（per person round trip）
  const [flightPrices, setFlightPrices] = useState<{
    econPerPerson: number; // 单人来回经济
    bizPerPerson: number; // 单人来回商务
    dateRank: string;
    loaded: boolean;
  }>({ econPerPerson: 0, bizPerPerson: 0, dateRank: 'C', loaded: false });

  const loadPrices = useCallback(async () => {
    try {
      // 搜去程 + 回程各 1 张
      const [go, ret] = await Promise.all([
        api.searchFlights({ origin: 'MFM', destination: 'DAD', date: goDate, passengers: 1 }),
        api.searchFlights({ origin: 'DAD', destination: 'MFM', date: returnDate, passengers: 1 }),
      ]);
      const goEcon = go.results[0]?.seatClasses.find((c) => c.cabin === 'ECONOMY');
      const retEcon = ret.results[0]?.seatClasses.find((c) => c.cabin === 'ECONOMY');
      const goBiz = go.results[0]?.seatClasses.find((c) => c.cabin === 'BUSINESS');
      const retBiz = ret.results[0]?.seatClasses.find((c) => c.cabin === 'BUSINESS');

      setFlightPrices({
        econPerPerson:
          (goEcon ? Number(goEcon.dynamicPrice) : 0) +
          (retEcon ? Number(retEcon.dynamicPrice) : 0),
        bizPerPerson:
          (goBiz ? Number(goBiz.dynamicPrice) : 0) +
          (retBiz ? Number(retBiz.dynamicPrice) : 0),
        dateRank: goEcon?.dateRank ?? 'C',
        loaded: true,
      });
    } catch {
      // fallback: basePrice 估算
      setFlightPrices({
        econPerPerson: 1480 + 1380, // MFM→DAD + DAD→MFM base
        bizPerPerson: 4380 + 4280,
        dateRank: 'C',
        loaded: true,
      });
    }
  }, [goDate, returnDate]);

  useEffect(() => {
    loadPrices();
  }, [loadPrices]);

  const visible = MOCK_BUNDLES.filter((b) => b.active);

  /** 计算某个 bundle 的完整价格 */
  const calcBundleTotal = useCallback(
    (b: MockBundle) => {
      const isBiz = b.items.some((i) => i.kind === 'FLIGHT' && i.productName.includes('商务'));
      const pricePerPerson = isBiz ? flightPrices.bizPerPerson : flightPrices.econPerPerson;
      const flightTotal = pricePerPerson * b.flightPax;
      const groundTotal = b.items
        .filter((i) => i.kind !== 'FLIGHT')
        .reduce((s, i) => s + i.unitPrice * i.qty, 0);
      const listTotal = flightTotal + groundTotal;
      const bundleTotal = listTotal - b.groundDiscount;
      return { flightTotal, groundTotal, listTotal, bundleTotal, pricePerPerson, isBiz };
    },
    [flightPrices],
  );

  return (
    <div className="space-y-5">
      <section className="rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 p-6 text-white">
        <h1 className="text-2xl font-bold">岘港全包套餐</h1>
        <p className="mt-1 text-sm text-emerald-50">
          来回机票 + 酒店 + 接送 + 签证一价全含。机票价格实时动态，选日期看价。
        </p>
      </section>

      {/* 日期选择器 → 影响机票动态价 */}
      <section className="card">
        <div className="grid gap-4 md:grid-cols-4">
          <div>
            <label className="label">去程日期</label>
            <input
              type="date"
              className="input"
              value={goDate}
              onChange={(e) => setGoDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label">回程日期</label>
            <input
              type="date"
              className="input"
              value={returnDate}
              min={goDate}
              onChange={(e) => setReturnDate(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-3">
            {flightPrices.loaded ? (
              <div className="text-sm">
                <span className={`rounded px-1.5 py-0.5 text-xs font-bold mr-1 ${
                  flightPrices.dateRank === 'A' ? 'bg-red-100 text-red-700' :
                  flightPrices.dateRank === 'B' ? 'bg-amber-100 text-amber-700' :
                  flightPrices.dateRank === 'C' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                }`}>{flightPrices.dateRank}</span>
                <span className="text-slate-600">
                  经济舱来回 <strong className="text-red-600">¥{flightPrices.econPerPerson.toLocaleString()}</strong>/人
                </span>
              </div>
            ) : (
              <span className="text-sm text-slate-500">加载机票价格…</span>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {visible.map((b) => {
          const calc = calcBundleTotal(b);
          return (
            <BundleCard
              key={b.id}
              bundle={b}
              calc={calc}
              dateRank={flightPrices.dateRank}
              onView={() => setSelected(b)}
              onAdd={() => {
                add({
                  kind: 'BUNDLE',
                  productId: b.id,
                  name: `${b.name}（${goDate} - ${returnDate}）`,
                  description: b.tagline,
                  emoji: b.emoji,
                  unitPrice: calc.bundleTotal,
                  qty: 1,
                  meta: {
                    goDate,
                    returnDate,
                    flightPax: b.flightPax,
                    flightTotal: calc.flightTotal,
                    groundTotal: calc.groundTotal,
                    discount: b.groundDiscount,
                  },
                });
              }}
            />
          );
        })}
      </section>

      {selected && (
        <BundleDetailModal
          bundle={selected}
          calc={calcBundleTotal(selected)}
          dateRank={flightPrices.dateRank}
          goDate={goDate}
          returnDate={returnDate}
          onClose={() => setSelected(null)}
          onAdd={(b) => {
            const calc = calcBundleTotal(b);
            add({
              kind: 'BUNDLE',
              productId: b.id,
              name: `${b.name}（${goDate} - ${returnDate}）`,
              description: b.tagline,
              emoji: b.emoji,
              unitPrice: calc.bundleTotal,
              qty: 1,
              meta: {
                goDate,
                returnDate,
                flightPax: b.flightPax,
                flightTotal: calc.flightTotal,
                groundTotal: calc.groundTotal,
                discount: b.groundDiscount,
              },
            });
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

interface CalcResult {
  flightTotal: number;
  groundTotal: number;
  listTotal: number;
  bundleTotal: number;
  pricePerPerson: number;
  isBiz: boolean;
}

function BundleCard({
  bundle,
  calc,
  dateRank,
  onView,
  onAdd,
}: {
  bundle: MockBundle;
  calc: CalcResult;
  dateRank: string;
  onView: () => void;
  onAdd: () => void;
}) {
  return (
    <article className="card hover:shadow-md transition">
      <div className="flex items-start gap-3">
        <span className="text-4xl">{bundle.emoji}</span>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-slate-900">{bundle.name}</h3>
          <p className="mt-0.5 text-sm text-slate-600">{bundle.tagline}</p>
          <p className="mt-0.5 text-xs text-slate-500">{bundle.suitableFor}</p>
        </div>
        <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${
          dateRank === 'A' ? 'bg-red-100 text-red-700' :
          dateRank === 'B' ? 'bg-amber-100 text-amber-700' :
          dateRank === 'C' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
        }`}>{dateRank}</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {bundle.items.map((i, idx) => (
          <span key={idx} className={`rounded px-2 py-0.5 text-xs ${KIND_LABEL[i.kind].color}`}>
            {KIND_LABEL[i.kind].label}
            {i.kind === 'FLIGHT'
              ? ` ${bundle.flightPax}人${calc.isBiz ? '商务' : '经济'}`
              : ` × ${i.qty}`}
          </span>
        ))}
      </div>

      <div className="mt-4 rounded-md bg-slate-50 p-3">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            机票 ¥{calc.flightTotal.toLocaleString()} + 地面 ¥{calc.groundTotal.toLocaleString()}
            {bundle.groundDiscount > 0 && ` − 让利 ¥${bundle.groundDiscount.toLocaleString()}`}
          </span>
        </div>
        <div className="mt-1 flex items-end justify-between">
          <span className="text-sm text-slate-700">套餐总价</span>
          <div>
            {bundle.groundDiscount > 0 && (
              <span className="text-xs text-slate-400 line-through mr-2">
                ¥{calc.listTotal.toLocaleString()}
              </span>
            )}
            <span className="text-2xl font-bold text-red-600">
              ¥{calc.bundleTotal.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button className="btn-secondary text-sm" onClick={onView}>看详情</button>
        <button className="btn-primary text-sm" onClick={onAdd}>加入购物车</button>
      </div>
    </article>
  );
}

function BundleDetailModal({
  bundle,
  calc,
  dateRank,
  goDate,
  returnDate,
  onClose,
  onAdd,
}: {
  bundle: MockBundle;
  calc: CalcResult;
  dateRank: string;
  goDate: string;
  returnDate: string;
  onClose: () => void;
  onAdd: (b: MockBundle) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">
            {bundle.emoji} {bundle.name}
          </h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>×</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-slate-600">{bundle.tagline}</p>
          <p className="text-xs text-slate-500">适合：{bundle.suitableFor}</p>
          <p className="text-xs text-slate-500">
            出行日期：{goDate} → {returnDate}
            <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-bold ${
              dateRank === 'A' ? 'bg-red-100 text-red-700' :
              dateRank === 'B' ? 'bg-amber-100 text-amber-700' :
              dateRank === 'C' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
            }`}>{dateRank} 等级</span>
          </p>

          <div>
            <h3 className="text-sm font-medium text-slate-700">套餐包含</h3>
            <ul className="mt-2 space-y-2">
              {bundle.items.map((i, idx) => (
                <li key={idx} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_LABEL[i.kind].color}`}>
                      {KIND_LABEL[i.kind].label}
                    </span>
                    <span className="text-slate-700 truncate">
                      {i.kind === 'FLIGHT'
                        ? `QH9588/9589 来回${calc.isBiz ? '商务' : '经济'}舱 × ${bundle.flightPax} 人`
                        : i.productName}
                    </span>
                  </div>
                  <span className="text-slate-500 whitespace-nowrap">
                    {i.kind === 'FLIGHT'
                      ? `¥${calc.flightTotal.toLocaleString()}`
                      : `${i.qty} × ¥${i.unitPrice} = ¥${(i.qty * i.unitPrice).toLocaleString()}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-md bg-slate-50 p-4">
            <div className="flex justify-between text-sm">
              <span className="text-slate-600">机票（动态价，按 {dateRank} 等级）</span>
              <span className="font-medium">¥{calc.flightTotal.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-sm mt-1">
              <span className="text-slate-600">地面服务</span>
              <span className="font-medium">¥{calc.groundTotal.toLocaleString()}</span>
            </div>
            {bundle.groundDiscount > 0 && (
              <div className="flex justify-between text-sm mt-1">
                <span className="text-slate-600">套餐让利</span>
                <span className="text-red-600">−¥{bundle.groundDiscount.toLocaleString()}</span>
              </div>
            )}
            <div className="mt-2 flex items-end justify-between border-t border-slate-200 pt-2">
              <span className="text-sm text-slate-600">套餐总价</span>
              <span className="text-2xl font-bold text-red-600">¥{calc.bundleTotal.toLocaleString()}</span>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              * 机票价格按出发日期 {dateRank} 等级 + 当前余位阶梯实时计算，最终以下单时为准
            </p>
          </div>

          <div className="flex justify-end gap-3">
            <button className="btn-secondary" onClick={onClose}>取消</button>
            <Link className="btn-secondary" to="/cart">查看购物车</Link>
            <button className="btn-primary" onClick={() => onAdd(bundle)}>加入购物车</button>
          </div>
        </div>
      </div>
    </div>
  );
}
