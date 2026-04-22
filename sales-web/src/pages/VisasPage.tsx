import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type MockVisa } from '../lib/mockData';
import { api, type Visa } from '../lib/api';
import { useCart } from '../stores/cart';

function visaApiToMock(v: Visa): MockVisa {
  return {
    id: v.id, country: v.country ?? v.destinationCountry, countryCode: v.destinationCountry,
    flag: v.flag ?? '🌐', photo: v.photo ?? '', type: v.visaName ?? v.visaType,
    processingDays: v.processingDays, basePrice: Number(v.basePrice),
    expressSurcharge: v.expressSurcharge ? Number(v.expressSurcharge) : 0,
    requiredDocs: v.requiredDocs, validityMonths: v.validityMonths ?? 1,
    highlight: v.highlight ?? undefined,
  };
}

export function VisasPage() {
  const [visas, setVisas] = useState<MockVisa[]>([]);
  const [search, setSearch] = useState('');
  const [maxDays, setMaxDays] = useState<'' | '7' | '15' | '30'>('');
  const [selected, setSelected] = useState<MockVisa | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listVisas().then((r) => { if (!cancelled) setVisas(r.visas.map(visaApiToMock)); }).catch(() => {/* 静默 */});
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    return visas.filter((v) => {
      if (search && !v.country.includes(search)) return false;
      if (maxDays && v.processingDays > Number(maxDays)) return false;
      return true;
    });
  }, [visas, search, maxDays]);

  return (
    <div className="space-y-6">
      <section className="card">
        <h1 className="text-2xl font-bold text-slate-900">越南及周边签证代办</h1>
        <p className="mt-1 text-sm text-slate-600">
          主打越南 E-visa / 落地签 / 商务签，最快 2 天出签。另代办东南亚常用签证。
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div>
            <label className="label">搜索目的国</label>
            <input
              className="input"
              placeholder="日本 / 韩国 / 申根…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label className="label">出签时效</label>
            <select
              className="input"
              value={maxDays}
              onChange={(e) => setMaxDays(e.target.value as '' | '7' | '15' | '30')}
            >
              <option value="">不限</option>
              <option value="7">7 天内</option>
              <option value="15">15 天内</option>
              <option value="30">30 天内</option>
            </select>
          </div>
          <div className="flex items-end">
            <p className="text-sm text-slate-500">共 {filtered.length} 个签证产品</p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((v) => (
          <article key={v.id} className="card hover:shadow-md transition cursor-pointer overflow-hidden p-0" onClick={() => setSelected(v)}>
            <div className="relative h-40 w-full overflow-hidden bg-slate-100">
              {v.photo ? (
                <img
                  src={v.photo}
                  alt={v.country}
                  className="h-full w-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              ) : null}
              <span className="absolute left-3 top-3 text-3xl drop-shadow">{v.flag}</span>
              <span className="absolute right-3 top-3 rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
                {v.processingDays} 天出签
              </span>
            </div>
            <div className="p-4">
            <h3 className="mt-0 font-semibold text-slate-900">{v.country}</h3>
            <p className="mt-0.5 text-sm text-slate-600">{v.type}</p>
            {v.highlight && (
              <p className="mt-1 text-xs font-medium text-emerald-700">★ {v.highlight}</p>
            )}
            <p className="mt-2 text-xs text-slate-500">有效期 {v.validityMonths} 个月 · 需材料 {v.requiredDocs.length} 项</p>
            <div className="mt-4 flex items-end justify-between">
              <div>
                <div className="text-xs text-slate-500">办理费</div>
                <div className="text-xl font-semibold text-red-600">¥{v.basePrice}</div>
                {v.expressSurcharge > 0 && (
                  <div className="text-xs text-amber-600">加急 +¥{v.expressSurcharge}</div>
                )}
              </div>
              <button className="btn-primary text-sm py-1.5">立即办理</button>
            </div>
            </div>
          </article>
        ))}
      </section>

      {filtered.length === 0 && (
        <div className="card text-slate-500">没有匹配的签证产品。</div>
      )}

      {selected && <VisaDetailModal visa={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function VisaDetailModal({ visa, onClose }: { visa: MockVisa; onClose: () => void }) {
  const [express, setExpress] = useState(false);
  const [count, setCount] = useState(1);
  const add = useCart((s) => s.add);
  const navigate = useNavigate();

  const unitPrice = visa.basePrice + (express ? visa.expressSurcharge : 0);
  const total = unitPrice * count;

  const addToCart = (goCart: boolean) => {
    add({
      kind: 'VISA',
      productId: visa.id + (express ? '-express' : ''),
      name: `${visa.country} · ${visa.type}${express ? ' (加急)' : ''} × ${count}`,
      description: `${visa.flag} ${express ? visa.processingDays - 2 : visa.processingDays} 天出签 · 有效期 ${visa.validityMonths} 个月`,
      emoji: visa.flag,
      unitPrice,
      qty: count,
      meta: { express, processingDays: express ? visa.processingDays - 2 : visa.processingDays },
    });
    onClose();
    if (goCart) navigate('/cart');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">
            {visa.flag} {visa.country} · {visa.type}
          </h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>×</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {(
            <>
              <div>
                <h3 className="font-medium text-slate-900">所需材料</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                  {visa.requiredDocs.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={express} onChange={(e) => setExpress(e.target.checked)} />
                    <span>加急办理（{visa.processingDays - 2} 天出签，+¥{visa.expressSurcharge}/人）</span>
                  </label>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm text-slate-600">申请人数</label>
                  <input
                    type="number"
                    min={1}
                    max={9}
                    className="input max-w-[6rem]"
                    value={count}
                    onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
                  />
                </div>
                <div className="flex items-end justify-between border-t border-slate-200 pt-3">
                  <span className="text-sm text-slate-600">合计</span>
                  <span className="text-2xl font-bold text-red-600">¥{total}</span>
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <button className="btn-secondary" onClick={onClose}>取消</button>
                <button className="btn-secondary" onClick={() => addToCart(false)}>🛒 加入购物车</button>
                <button className="btn-primary" onClick={() => addToCart(true)}>立即购买 →</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
