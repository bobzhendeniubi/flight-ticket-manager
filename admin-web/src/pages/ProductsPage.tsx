/**
 * 产品管理 — 4 个 section（酒店 / 接送 / 签证 / 套餐）。
 *
 * 当前数据源：lib/mockData.ts 里的 MOCK_HOTELS / MOCK_TRANSFERS / MOCK_VISAS / MOCK_BUNDLES。
 * 操作（启停 / 新建 / 编辑）只在当前会话生效，刷新后回到默认值。
 * 真接 API 后会改为 backend `/admin/hotels` `/admin/transfers` `/admin/visas` `/admin/bundles`。
 */
import { useMemo, useState } from 'react';
import {
  MOCK_HOTELS,
  MOCK_TRANSFERS,
  MOCK_VISAS,
  MOCK_BUNDLES,
  type MockHotel,
  type MockTransfer,
  type MockVisa,
  type MockBundle,
  type BundleItem,
} from '../lib/mockData';

type Section = 'hotels' | 'transfers' | 'visas' | 'bundles';

const SECTIONS: { key: Section; label: string; emoji: string }[] = [
  { key: 'hotels', label: '酒店', emoji: '🏨' },
  { key: 'transfers', label: '机场接送', emoji: '🚐' },
  { key: 'visas', label: '签证', emoji: '🛂' },
  { key: 'bundles', label: '套餐 / Bundle', emoji: '🎁' },
];

export function ProductsPage() {
  const [section, setSection] = useState<Section>('hotels');
  const [hotels, setHotels] = useState<MockHotel[]>(MOCK_HOTELS);
  const [transfers, setTransfers] = useState<MockTransfer[]>(MOCK_TRANSFERS);
  const [visas, setVisas] = useState<MockVisa[]>(MOCK_VISAS);
  const [bundles, setBundles] = useState<MockBundle[]>(MOCK_BUNDLES);

  return (
    <div className="space-y-5">
      <section>
        <h1 className="text-2xl font-bold text-slate-900">产品管理</h1>
        <p className="mt-1 text-sm text-slate-600">
          维护酒店、机场接送、签证三大基础产品，组合成套餐 (Bundle) 销售。
          套餐可让利定价，提升客单价和打包销售率。
        </p>
        <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          ⓘ Demo 模式：所有变更仅在当前会话生效。真实环境会写入 backend `/admin/{`hotels|transfers|visas|bundles`}`。
        </div>
      </section>

      {/* Tabs */}
      <nav className="flex flex-wrap gap-2 border-b border-slate-200">
        {SECTIONS.map((s) => {
          const isSel = section === s.key;
          const count = {
            hotels: hotels.length,
            transfers: transfers.length,
            visas: visas.length,
            bundles: bundles.length,
          }[s.key];
          return (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`px-4 py-2.5 text-sm border-b-2 transition ${
                isSel
                  ? 'border-brand text-brand font-medium'
                  : 'border-transparent text-slate-600 hover:text-brand hover:border-brand/30'
              }`}
            >
              <span className="mr-1.5">{s.emoji}</span>
              {s.label}
              <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{count}</span>
            </button>
          );
        })}
      </nav>

      {section === 'hotels' && <HotelsSection items={hotels} onChange={setHotels} />}
      {section === 'transfers' && <TransfersSection items={transfers} onChange={setTransfers} />}
      {section === 'visas' && <VisasSection items={visas} onChange={setVisas} />}
      {section === 'bundles' && (
        <BundlesSection items={bundles} onChange={setBundles} />
      )}
    </div>
  );
}

// ─── 酒店 ───────────────────────────────────────────────────────────
function HotelsSection({ items, onChange }: { items: MockHotel[]; onChange: (v: MockHotel[]) => void }) {
  const [showForm, setShowForm] = useState(false);
  return (
    <div className="space-y-3">
      <ActionBar active={items.length} onAdd={() => setShowForm(true)} addLabel="+ 新增酒店" />
      {showForm && (
        <NewHotelForm
          onCancel={() => setShowForm(false)}
          onSubmit={(h) => {
            onChange([h, ...items]);
            setShowForm(false);
          }}
        />
      )}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {items.map((h) => (
          <div key={h.id} className="card">
            <div className="flex items-start justify-between">
              <div className="text-3xl">{h.emoji}</div>
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                {'★'.repeat(h.stars)}
              </span>
            </div>
            <h3 className="mt-2 font-semibold text-slate-900">{h.name}</h3>
            <p className="text-xs text-slate-500">{h.nameEn}</p>
            <p className="mt-1 text-xs text-slate-500">📍 {h.area}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {h.amenities.slice(0, 3).map((a) => (
                <span key={a} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {a}
                </span>
              ))}
            </div>
            <div className="mt-3 flex items-end justify-between">
              <div>
                <div className="text-xs text-slate-500">每晚起</div>
                <div className="text-lg font-semibold text-red-600">¥{h.basePrice}</div>
              </div>
              <button
                className="text-xs text-slate-500 hover:text-red-600"
                onClick={() => onChange(items.filter((x) => x.id !== h.id))}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NewHotelForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (h: MockHotel) => void;
}) {
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [area, setArea] = useState('美溪海滩');
  const [stars, setStars] = useState<3 | 4 | 5>(4);
  const [basePrice, setBasePrice] = useState(880);

  return (
    <section className="card border-brand/30">
      <h3 className="font-semibold text-slate-900">新增酒店</h3>
      <form
        className="mt-3 grid gap-3 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            id: 'h-' + Date.now(),
            name,
            nameEn,
            cityCode: 'DAD',
            area,
            stars,
            basePrice,
            rating: 4.5,
            reviewCount: 0,
            emoji: '🏨',
            photo: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=600&h=400&fit=crop',
            amenities: ['免费 WiFi', '含早餐'],
            highlight: '新增酒店（demo）',
          });
        }}
      >
        <div>
          <label className="label">中文名 *</label>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">英文名</label>
          <input className="input" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </div>
        <div>
          <label className="label">区域</label>
          <select className="input" value={area} onChange={(e) => setArea(e.target.value)}>
            <option>美溪海滩</option>
            <option>山茶半岛</option>
            <option>会安</option>
            <option>市中心</option>
          </select>
        </div>
        <div>
          <label className="label">星级</label>
          <select
            className="input"
            value={stars}
            onChange={(e) => setStars(Number(e.target.value) as 3 | 4 | 5)}
          >
            <option value={3}>三星</option>
            <option value={4}>四星</option>
            <option value={5}>五星</option>
          </select>
        </div>
        <div>
          <label className="label">每晚起价 (¥)</label>
          <input
            type="number"
            min={100}
            className="input"
            value={basePrice}
            onChange={(e) => setBasePrice(Number(e.target.value) || 0)}
          />
        </div>
        <div className="md:col-span-3 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary">添加</button>
        </div>
      </form>
    </section>
  );
}

// ─── 接送 ───────────────────────────────────────────────────────────
function TransfersSection({ items, onChange }: { items: MockTransfer[]; onChange: (v: MockTransfer[]) => void }) {
  return (
    <div className="space-y-3">
      <ActionBar
        active={items.length}
        onAdd={() =>
          onChange([
            {
              id: 't-' + Date.now(),
              name: '新增接送服务',
              vehicleType: '舒适型轿车',
              capacity: 3,
              basePrice: 128,
              originArea: '岘港机场 (DAD)',
              destArea: '美溪海滩',
              emoji: '🚗',
              photo: 'https://images.unsplash.com/photo-1549317661-bd32c8ce0afa?w=600&h=400&fit=crop',
              features: ['含中文司机'],
              duration: '约 15 分钟',
            },
            ...items,
          ])
        }
        addLabel="+ 新增车型"
      />
      <div className="space-y-3">
        {items.map((t) => (
          <article key={t.id} className="card flex items-center gap-6">
            <div className="text-4xl">{t.emoji}</div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-slate-900">{t.name}</h3>
              <p className="text-sm text-slate-600">{t.vehicleType}</p>
              <p className="mt-1 text-xs text-slate-500">
                {t.originArea} → {t.destArea} · 最多 {t.capacity} 人 · {t.duration}
              </p>
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500">起步价</div>
              <div className="text-xl font-bold text-red-600">¥{t.basePrice}</div>
              <button
                className="mt-1 text-xs text-slate-500 hover:text-red-600"
                onClick={() => onChange(items.filter((x) => x.id !== t.id))}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

// ─── 签证 ───────────────────────────────────────────────────────────
function VisasSection({ items, onChange }: { items: MockVisa[]; onChange: (v: MockVisa[]) => void }) {
  return (
    <div className="space-y-3">
      <ActionBar
        active={items.length}
        onAdd={() =>
          onChange([
            {
              id: 'v-' + Date.now(),
              country: '新增国家',
              countryCode: 'XX',
              flag: '🌍',
              type: '旅游签',
              processingDays: 7,
              basePrice: 380,
              expressSurcharge: 150,
              requiredDocs: ['护照', '照片'],
              validityMonths: 3,
            },
            ...items,
          ])
        }
        addLabel="+ 新增签证产品"
      />
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {items.map((v) => (
          <div key={v.id} className="card">
            <div className="flex items-start justify-between">
              <span className="text-4xl">{v.flag}</span>
              <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
                {v.processingDays} 天出签
              </span>
            </div>
            <h3 className="mt-2 font-semibold text-slate-900">
              {v.country} · {v.type}
            </h3>
            {v.highlight && (
              <p className="mt-1 text-xs font-medium text-emerald-700">★ {v.highlight}</p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              有效期 {v.validityMonths} 个月 · 材料 {v.requiredDocs.length} 项
            </p>
            <div className="mt-3 flex items-end justify-between">
              <div>
                <div className="text-xs text-slate-500">办理费</div>
                <div className="text-lg font-semibold text-red-600">¥{v.basePrice}</div>
              </div>
              <button
                className="text-xs text-slate-500 hover:text-red-600"
                onClick={() => onChange(items.filter((x) => x.id !== v.id))}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 套餐 ───────────────────────────────────────────────────────────
function BundlesSection({
  items,
  onChange,
}: {
  items: MockBundle[];
  onChange: (v: MockBundle[]) => void;
}) {
  const [showWizard, setShowWizard] = useState(false);
  return (
    <div className="space-y-3">
      <ActionBar active={items.length} onAdd={() => setShowWizard(true)} addLabel="+ 新建套餐" />
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((b) => (
          <BundleCard key={b.id} bundle={b} onToggle={() => onChange(items.map((x) => (x.id === b.id ? { ...x, active: !x.active } : x)))} onDelete={() => onChange(items.filter((x) => x.id !== b.id))} />
        ))}
      </div>
      {showWizard && (
        <NewBundleWizard
          onCancel={() => setShowWizard(false)}
          onSubmit={(b) => {
            onChange([b, ...items]);
            setShowWizard(false);
          }}
        />
      )}
    </div>
  );
}

const KIND_LABEL: Record<BundleItem['kind'], { label: string; color: string }> = {
  FLIGHT: { label: '机票', color: 'bg-sky-100 text-sky-700' },
  HOTEL: { label: '酒店', color: 'bg-purple-100 text-purple-700' },
  TRANSFER: { label: '接送', color: 'bg-pink-100 text-pink-700' },
  VISA: { label: '签证', color: 'bg-amber-100 text-amber-700' },
};

function BundleCard({
  bundle,
  onToggle,
  onDelete,
}: {
  bundle: MockBundle;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const saving = bundle.listPrice - bundle.bundlePrice;
  const savingPct = bundle.listPrice > 0 ? (saving / bundle.listPrice) * 100 : 0;
  return (
    <article className={`card ${bundle.active ? '' : 'opacity-60'}`}>
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <span className="text-3xl">{bundle.emoji}</span>
          <div>
            <h3 className="font-semibold text-slate-900">{bundle.name}</h3>
            <p className="text-xs text-slate-600 mt-0.5">{bundle.tagline}</p>
            <p className="text-xs text-slate-500 mt-0.5">{bundle.suitableFor}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              bundle.active ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-500'
            }`}
          >
            {bundle.active ? '在售' : '已停'}
          </span>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        {bundle.items.map((i, idx) => (
          <div key={idx} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`rounded px-1.5 py-0.5 font-medium ${KIND_LABEL[i.kind].color}`}>
                {KIND_LABEL[i.kind].label}
              </span>
              <span className="text-slate-700 truncate">{i.productName}</span>
            </div>
            <span className="text-slate-500 tabular-nums whitespace-nowrap">
              {i.qty} × ¥{i.unitPrice} = ¥{(i.qty * i.unitPrice).toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-md bg-slate-50 p-3">
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>单买总价</span>
          <span className="line-through">¥{bundle.listPrice.toLocaleString()}</span>
        </div>
        <div className="mt-1 flex items-end justify-between">
          <span className="text-sm text-slate-600">套餐价</span>
          <div>
            <span className="text-2xl font-bold text-red-600">¥{bundle.bundlePrice.toLocaleString()}</span>
            <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
              省 ¥{saving.toLocaleString()} ({savingPct.toFixed(0)}%)
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-3 text-xs">
        <button className="text-slate-500 hover:text-brand" onClick={onToggle}>
          {bundle.active ? '停用' : '启用'}
        </button>
        <button className="text-slate-500 hover:text-red-600" onClick={onDelete}>
          删除
        </button>
      </div>
    </article>
  );
}

function NewBundleWizard({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (b: MockBundle) => void;
}) {
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [emoji, setEmoji] = useState('🎁');
  const [suitableFor, setSuitableFor] = useState('2 大人');
  const [items, setItems] = useState<BundleItem[]>([
    { kind: 'HOTEL', productName: '岘港凯悦度假村 3 晚', qty: 3, unitPrice: 1880 },
  ]);
  const [discount, setDiscount] = useState(500);

  const listPrice = useMemo(() => items.reduce((s, i) => s + i.qty * i.unitPrice, 0), [items]);
  const bundlePrice = Math.max(0, listPrice - discount);
  const valid = name.length > 0 && items.length > 0 && bundlePrice > 0;

  const addItem = (kind: BundleItem['kind']) => {
    const presets: Record<BundleItem['kind'], BundleItem> = {
      FLIGHT: { kind: 'HOTEL', productName: '（请从下方添加）', qty: 1, unitPrice: 0 },
      HOTEL: { kind: 'HOTEL', productName: '岘港凯悦度假村 1 晚', qty: 3, unitPrice: 1880 },
      TRANSFER: { kind: 'TRANSFER', productName: '岘港机场接送 商务车', qty: 2, unitPrice: 188 },
      VISA: { kind: 'VISA', productName: '越南 E-visa 30 天', qty: 2, unitPrice: 280 },
    };
    setItems([...items, presets[kind]]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">新建套餐</h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onCancel}>×</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className="label">套餐名 *</label>
              <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="如 岘港 4 天 3 晚 经典" />
            </div>
            <div>
              <label className="label">图标</label>
              <input className="input" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={3} />
            </div>
          </div>
          <div>
            <label className="label">营销文案</label>
            <input className="input" value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="一句话卖点" />
          </div>
          <div>
            <label className="label">适合人群</label>
            <input className="input" value={suitableFor} onChange={(e) => setSuitableFor(e.target.value)} />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="label !mb-0">套餐内容</label>
              <div className="flex gap-2">
                {(['HOTEL', 'TRANSFER', 'VISA'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`text-xs rounded px-2 py-1 ${KIND_LABEL[k].color} hover:opacity-80`}
                    onClick={() => addItem(k)}
                  >
                    + {KIND_LABEL[k].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 space-y-2">
              {items.map((it, idx) => (
                <div key={idx} className="flex items-center gap-2 rounded border border-slate-200 p-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_LABEL[it.kind].color}`}>
                    {KIND_LABEL[it.kind].label}
                  </span>
                  <input
                    className="input flex-1 text-xs"
                    value={it.productName}
                    onChange={(e) => {
                      const next = [...items];
                      next[idx] = { ...it, productName: e.target.value };
                      setItems(next);
                    }}
                  />
                  <input
                    type="number"
                    min={1}
                    className="input w-16 text-xs"
                    value={it.qty}
                    onChange={(e) => {
                      const next = [...items];
                      next[idx] = { ...it, qty: Math.max(1, Number(e.target.value) || 1) };
                      setItems(next);
                    }}
                  />
                  <input
                    type="number"
                    min={0}
                    className="input w-24 text-xs"
                    value={it.unitPrice}
                    onChange={(e) => {
                      const next = [...items];
                      next[idx] = { ...it, unitPrice: Number(e.target.value) || 0 };
                      setItems(next);
                    }}
                  />
                  <span className="text-xs text-slate-500 w-20 text-right">
                    ¥{(it.qty * it.unitPrice).toLocaleString()}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-red-600 hover:text-red-700"
                    onClick={() => setItems(items.filter((_, i) => i !== idx))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md bg-slate-50 p-3 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">单买总价</span>
              <span className="font-medium">¥{listPrice.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">让利金额</span>
              <input
                type="number"
                min={0}
                max={listPrice}
                className="input w-32 text-right"
                value={discount}
                onChange={(e) => setDiscount(Math.min(listPrice, Math.max(0, Number(e.target.value) || 0)))}
              />
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 pt-2">
              <span className="text-sm text-slate-600">套餐价</span>
              <span className="text-2xl font-bold text-red-600">¥{bundlePrice.toLocaleString()}</span>
            </div>
            {!valid && (
              <p className="text-xs text-red-600">⚠️ 请填写套餐名 + 至少 1 个产品 + 套餐价 &gt; 0</p>
            )}
          </div>

          <div className="flex justify-end gap-3">
            <button className="btn-secondary" onClick={onCancel}>取消</button>
            <button
              className="btn-primary"
              disabled={!valid}
              onClick={() =>
                onSubmit({
                  id: 'b-' + Date.now(),
                  name,
                  tagline: tagline || '新建套餐',
                  emoji,
                  items,
                  listPrice,
                  bundlePrice,
                  suitableFor,
                  active: true,
                })
              }
            >
              创建套餐
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 公共 ────────────────────────────────────────────────────────────
function ActionBar({ active, onAdd, addLabel }: { active: number; onAdd: () => void; addLabel: string }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-slate-500">共 {active} 项</p>
      <button className="btn-primary text-sm" onClick={onAdd}>{addLabel}</button>
    </div>
  );
}
