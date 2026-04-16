/** 套餐展示页 — 客户端浏览所有 Bundle，可加入购物车 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MOCK_BUNDLES, type MockBundle, type BundleItem } from '../lib/mockData';
import { useCart } from '../stores/cart';

const KIND_LABEL: Record<BundleItem['kind'], { label: string; color: string }> = {
  FLIGHT: { label: '机票', color: 'bg-sky-100 text-sky-700' },
  HOTEL: { label: '酒店', color: 'bg-purple-100 text-purple-700' },
  TRANSFER: { label: '接送', color: 'bg-pink-100 text-pink-700' },
  VISA: { label: '签证', color: 'bg-amber-100 text-amber-700' },
};

export function BundlesPage() {
  const [selected, setSelected] = useState<MockBundle | null>(null);
  const add = useCart((s) => s.add);

  const visible = MOCK_BUNDLES.filter((b) => b.active);

  return (
    <div className="space-y-5">
      <section className="rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 p-6 text-white">
        <h1 className="text-2xl font-bold">岘港主题套餐</h1>
        <p className="mt-1 text-sm text-emerald-50">
          机票 + 酒店 + 接送 + 签证打包，比单独购买省更多。{visible.length} 个套餐供选择。
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {visible.map((b) => (
          <BundleCard
            key={b.id}
            bundle={b}
            onView={() => setSelected(b)}
            onAdd={() => {
              add({
                kind: 'BUNDLE',
                productId: b.id,
                name: b.name,
                description: b.tagline,
                emoji: b.emoji,
                unitPrice: b.bundlePrice,
                qty: 1,
                meta: { listPrice: b.listPrice, items: b.items.length },
              });
            }}
          />
        ))}
      </section>

      {selected && <BundleDetailModal bundle={selected} onClose={() => setSelected(null)} onAdd={(b) => {
        add({
          kind: 'BUNDLE',
          productId: b.id,
          name: b.name,
          description: b.tagline,
          emoji: b.emoji,
          unitPrice: b.bundlePrice,
          qty: 1,
          meta: { listPrice: b.listPrice, items: b.items.length },
        });
        setSelected(null);
      }} />}
    </div>
  );
}

function BundleCard({
  bundle,
  onView,
  onAdd,
}: {
  bundle: MockBundle;
  onView: () => void;
  onAdd: () => void;
}) {
  const saving = bundle.listPrice - bundle.bundlePrice;
  const savingPct = (saving / bundle.listPrice) * 100;

  return (
    <article className="card hover:shadow-md transition">
      <div className="flex items-start gap-3">
        <span className="text-4xl">{bundle.emoji}</span>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-slate-900">{bundle.name}</h3>
          <p className="mt-0.5 text-sm text-slate-600">{bundle.tagline}</p>
          <p className="mt-0.5 text-xs text-slate-500">{bundle.suitableFor}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {bundle.items.map((i, idx) => (
          <span key={idx} className={`rounded px-2 py-0.5 text-xs ${KIND_LABEL[i.kind].color}`}>
            {KIND_LABEL[i.kind].label} × {i.qty}
          </span>
        ))}
      </div>

      <div className="mt-4 rounded-md bg-slate-50 p-3">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>单买总价</span>
          <span className="line-through">¥{bundle.listPrice.toLocaleString()}</span>
        </div>
        <div className="mt-1 flex items-end justify-between">
          <span className="text-sm text-slate-700">套餐价</span>
          <div>
            <span className="text-2xl font-bold text-red-600">¥{bundle.bundlePrice.toLocaleString()}</span>
            <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
              省 {savingPct.toFixed(0)}%
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button className="btn-secondary text-sm" onClick={onView}>
          看详情
        </button>
        <button className="btn-primary text-sm" onClick={onAdd}>
          加入购物车
        </button>
      </div>
    </article>
  );
}

function BundleDetailModal({
  bundle,
  onClose,
  onAdd,
}: {
  bundle: MockBundle;
  onClose: () => void;
  onAdd: (b: MockBundle) => void;
}) {
  const saving = bundle.listPrice - bundle.bundlePrice;
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
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-slate-600">{bundle.tagline}</p>
          <p className="text-xs text-slate-500">适合：{bundle.suitableFor}</p>

          <div>
            <h3 className="text-sm font-medium text-slate-700">套餐内容</h3>
            <ul className="mt-2 space-y-2">
              {bundle.items.map((i, idx) => (
                <li key={idx} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_LABEL[i.kind].color}`}>
                      {KIND_LABEL[i.kind].label}
                    </span>
                    <span className="text-slate-700 truncate">{i.productName}</span>
                  </div>
                  <span className="text-slate-500 whitespace-nowrap">
                    {i.qty} × ¥{i.unitPrice} = ¥{(i.qty * i.unitPrice).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-md bg-slate-50 p-4">
            <div className="flex justify-between text-sm">
              <span className="text-slate-600">单买总价</span>
              <span className="line-through text-slate-500">¥{bundle.listPrice.toLocaleString()}</span>
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-slate-600">套餐让利</span>
              <span className="text-red-600">−¥{saving.toLocaleString()}</span>
            </div>
            <div className="mt-2 flex items-end justify-between border-t border-slate-200 pt-2">
              <span className="text-sm text-slate-600">套餐价</span>
              <span className="text-2xl font-bold text-red-600">¥{bundle.bundlePrice.toLocaleString()}</span>
            </div>
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
