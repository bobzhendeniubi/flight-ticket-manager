import { useMemo, useState } from 'react';
import { MOCK_VISAS, type MockVisa } from '../lib/mockData';

export function VisasPage() {
  const [search, setSearch] = useState('');
  const [maxDays, setMaxDays] = useState<'' | '7' | '15' | '30'>('');
  const [selected, setSelected] = useState<MockVisa | null>(null);

  const filtered = useMemo(() => {
    return MOCK_VISAS.filter((v) => {
      if (search && !v.country.includes(search)) return false;
      if (maxDays && v.processingDays > Number(maxDays)) return false;
      return true;
    });
  }, [search, maxDays]);

  return (
    <div className="space-y-6">
      <section className="card">
        <h1 className="text-2xl font-bold text-slate-900">签证办理</h1>
        <p className="mt-1 text-sm text-slate-600">
          覆盖主流出境目的地，支持加急办理，材料上传后由专员审核。
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
          <article key={v.id} className="card hover:shadow-md transition cursor-pointer" onClick={() => setSelected(v)}>
            <div className="flex items-start justify-between">
              <span className="text-5xl">{v.flag}</span>
              <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
                {v.processingDays} 天出签
              </span>
            </div>
            <h3 className="mt-3 font-semibold text-slate-900">{v.country}</h3>
            <p className="mt-0.5 text-sm text-slate-600">{v.type}</p>
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
  const [submitted, setSubmitted] = useState(false);

  const total = (visa.basePrice + (express ? visa.expressSurcharge : 0)) * count;

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
          {submitted ? (
            <div className="rounded-md bg-green-50 p-5 text-green-700">
              <div className="text-2xl">✅</div>
              <h3 className="mt-2 text-lg font-semibold">签证订单已创建（demo）</h3>
              <p className="mt-1 text-sm">
                请登录小程序或网页「我的订单」上传材料。预计 {express ? visa.processingDays - 2 : visa.processingDays} 天出签。
              </p>
              <button className="btn-secondary mt-4" onClick={onClose}>关闭</button>
            </div>
          ) : (
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
                <button className="btn-primary" onClick={() => setSubmitted(true)}>
                  创建订单
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
