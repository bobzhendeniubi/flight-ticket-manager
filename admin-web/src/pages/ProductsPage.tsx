/**
 * 产品管理 — 4 个 section（酒店 / 接送 / 签证 / 套餐）。
 *
 * 数据源：`/products/{hotels,transfers,visas,bundles}` 真后端。
 * 所有 CRUD 操作真写入数据库。删除走软删除（isActive=false）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  type MockHotel,
  type HotelRoomType,
  type MockTransfer,
  type MockVisa,
  type MockBundle,
  type BundleItem,
} from '../lib/mockData';
import { api, ApiError, type Hotel, type Transfer as ApiTransfer, type Visa as ApiVisa, type Bundle as ApiBundle } from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';
import { BundleBlackoutEditor, type BlackoutDateRow } from '../components/BundleBlackoutEditor';

type Section = 'hotels' | 'transfers' | 'visas' | 'bundles';

const SECTIONS: { key: Section; label: string; emoji: string }[] = [
  { key: 'hotels', label: '酒店', emoji: '🏨' },
  { key: 'transfers', label: '地面服务', emoji: '🚐' },
  { key: 'visas', label: '签证', emoji: '🛂' },
  { key: 'bundles', label: '套餐 / Bundle', emoji: '🎁' },
];

/** 归一化酒店图片：优先用 photos[]，回退到单张 photo，去空去重 */
function hotelPhotos(h: MockHotel): string[] {
  const list = (h.photos && h.photos.length > 0 ? h.photos : h.photo ? [h.photo] : [])
    .map((u) => u.trim())
    .filter(Boolean);
  return Array.from(new Set(list));
}

// ─── API → Mock 适配器（保留现有 UI，不改子组件） ───────────────────
function hotelApiToMock(h: Hotel): MockHotel {
  return {
    id: h.id,
    code: h.code,
    name: h.name,
    nameEn: h.nameEn ?? h.name,
    cityCode: h.cityCode,
    area: h.area ?? h.address,
    address: h.address ?? '',
    stars: (h.starRating as 3 | 4 | 5) ?? 4,
    basePrice: Number(h.basePrice ?? 0),
    rating: h.rating ? Number(h.rating) : 4.5,
    reviewCount: h.reviewCount ?? 0,
    emoji: h.emoji ?? '🏨',
    photo: h.photos[0] ?? '',
    photos: h.photos ?? [],
    amenities: h.amenities,
    highlight: h.highlight ?? '',
    roomTypes: h.roomTypes.map((rt) => ({
      name: rt.name,
      priceMult: rt.priceMultiplier ? Number(rt.priceMultiplier) : 1,
      sleeps: rt.capacity,
      bedType: rt.bedType ?? '',
      maxAdults: rt.maxAdults ?? 2,
      maxChildren: rt.maxChildren ?? 1,
    })),
  };
}

function transferApiToMock(t: ApiTransfer): MockTransfer {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    vehicleType: t.vehicleType,
    capacity: t.capacity,
    basePrice: Number(t.basePrice),
    originArea: t.originArea,
    destArea: t.destArea,
    emoji: t.emoji ?? '🚗',
    photo: t.photo ?? '',
    features: t.features,
    duration: t.duration ?? '',
  };
}

function visaApiToMock(v: ApiVisa): MockVisa {
  return {
    id: v.id,
    code: v.code,
    country: v.country ?? v.destinationCountry,
    countryCode: v.destinationCountry,
    flag: v.flag ?? '🌐',
    type: v.visaName ?? v.visaType,
    processingDays: v.processingDays,
    basePrice: Number(v.basePrice),
    expressSurcharge: v.expressSurcharge ? Number(v.expressSurcharge) : 0,
    requiredDocs: v.requiredDocs,
    validityMonths: v.validityMonths ?? 1,
    highlight: v.highlight ?? undefined,
  };
}

function bundleApiToMock(b: ApiBundle): MockBundle {
  const items = (b.items as BundleItem[]) ?? [];
  const groundTotal = items.filter((i) => i.kind !== 'FLIGHT').reduce((s, i) => s + i.unitPrice * i.qty, 0);
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    tagline: b.tagline ?? '',
    emoji: b.emoji ?? '🎁',
    items,
    listPrice: groundTotal,
    bundlePrice: groundTotal,
    groundDiscount: Number(b.groundDiscount),
    flightPax: b.flightPax,
    suitableFor: b.suitableFor ?? '',
    active: b.isActive,
    hotelRoomTypeId: b.hotelRoomTypeId,
    hotelNights: b.hotelNights,
    hotelRoomType: b.hotelRoomType,
    singleSupplementCnyPerNight: b.singleSupplementCnyPerNight,
    businessUpgradeCnyPerLeg: b.businessUpgradeCnyPerLeg,
    childSeatDiscountCnyPerPerson: b.childSeatDiscountCnyPerPerson,
    infantPriceCny: b.infantPriceCny,
    legs: b.legs,
    blackoutDates: b.blackoutDates ?? [],
    defaultDepartDate: b.defaultDepartDate ?? null,
  };
}

/** 套餐表单的酒店房型下拉选项（酒店名 · 房型名，value = roomTypeId） */
interface RoomTypeOption {
  id: string;
  label: string;
}

export function ProductsPage() {
  const tokens = useAuth((s) => s.tokens);
  const [section, setSection] = useState<Section>('hotels');
  const [hotels, setHotels] = useState<MockHotel[]>([]);
  const [transfers, setTransfers] = useState<MockTransfer[]>([]);
  const [visas, setVisas] = useState<MockVisa[]>([]);
  const [bundles, setBundles] = useState<MockBundle[]>([]);
  const [roomTypeOptions, setRoomTypeOptions] = useState<RoomTypeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.listHotels(false), api.listTransfers(false), api.listVisas(false), api.listBundles(false)])
      .then(([h, t, v, b]) => {
        if (cancelled) return;
        setHotels(h.hotels.map(hotelApiToMock));
        setTransfers(t.transfers.map(transferApiToMock));
        setVisas(v.visas.map(visaApiToMock));
        setBundles(b.bundles.map(bundleApiToMock));
        setRoomTypeOptions(
          h.hotels.flatMap((ht) => ht.roomTypes.map((rt) => ({ id: rt.id, label: `${ht.name} · ${rt.name}` }))),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const tk = tokens?.accessToken ?? '';

  async function persistHotels(next: MockHotel[]) {
    const prev = hotels;
    setHotels(next);
    try {
      for (const old of prev) if (!next.find((n) => n.id === old.id)) await api.deleteHotel(tk, old.id);
      for (const n of next) if (!prev.find((p) => p.id === n.id)) {
        await api.createHotel(tk, {
          name: n.name, nameEn: n.nameEn, cityCode: n.cityCode, area: n.area,
          address: n.address || n.area, starRating: n.stars, basePrice: n.basePrice,
          rating: n.rating, reviewCount: n.reviewCount, emoji: n.emoji,
          highlight: n.highlight, amenities: n.amenities, photos: hotelPhotos(n),
          roomTypes: n.roomTypes.map((rt) => ({
            name: rt.name, bedType: rt.bedType, capacity: rt.sleeps,
            basePrice: n.basePrice * rt.priceMult, priceMultiplier: rt.priceMult,
            maxAdults: rt.maxAdults ?? 2, maxChildren: rt.maxChildren ?? 1,
          })),
        });
      }
      for (const n of next) {
        const old = prev.find((p) => p.id === n.id);
        if (old && JSON.stringify(old) !== JSON.stringify(n)) {
          await api.updateHotel(tk, n.id, {
            name: n.name, nameEn: n.nameEn, cityCode: n.cityCode, area: n.area,
            address: n.address || n.area, starRating: n.stars,
            basePrice: n.basePrice, rating: n.rating, reviewCount: n.reviewCount,
            emoji: n.emoji, highlight: n.highlight, amenities: n.amenities,
            photos: hotelPhotos(n),
            roomTypes: n.roomTypes.map((rt) => ({
              name: rt.name, bedType: rt.bedType, capacity: rt.sleeps,
              basePrice: n.basePrice * rt.priceMult, priceMultiplier: rt.priceMult,
              maxAdults: rt.maxAdults ?? 2, maxChildren: rt.maxChildren ?? 1,
            })),
          });
        }
      }
      const fresh = await api.listHotels(false);
      setHotels(fresh.hotels.map(hotelApiToMock));
    } catch (e) {
      alert(e instanceof ApiError ? `保存失败：${e.message}` : '保存失败');
      setHotels(prev);
    }
  }

  async function persistTransfers(next: MockTransfer[]) {
    const prev = transfers;
    setTransfers(next);
    try {
      for (const old of prev) if (!next.find((n) => n.id === old.id)) await api.deleteTransfer(tk, old.id);
      for (const n of next) if (!prev.find((p) => p.id === n.id)) {
        await api.createTransfer(tk, {
          name: n.name, vehicleType: n.vehicleType, capacity: n.capacity,
          originArea: n.originArea, destArea: n.destArea, basePrice: n.basePrice,
          features: n.features, duration: n.duration, emoji: n.emoji, photo: n.photo,
        });
      }
      for (const n of next) {
        const old = prev.find((p) => p.id === n.id);
        if (old && JSON.stringify(old) !== JSON.stringify(n)) {
          await api.updateTransfer(tk, n.id, {
            name: n.name, vehicleType: n.vehicleType, capacity: n.capacity,
            originArea: n.originArea, destArea: n.destArea,
            features: n.features, duration: n.duration, emoji: n.emoji, photo: n.photo,
          });
        }
      }
      const fresh = await api.listTransfers(false);
      setTransfers(fresh.transfers.map(transferApiToMock));
    } catch (e) {
      alert(e instanceof ApiError ? `保存失败：${e.message}` : '保存失败');
      setTransfers(prev);
    }
  }

  async function persistVisas(next: MockVisa[]) {
    const prev = visas;
    setVisas(next);
    try {
      for (const old of prev) if (!next.find((n) => n.id === old.id)) await api.deleteVisa(tk, old.id);
      for (const n of next) if (!prev.find((p) => p.id === n.id)) {
        await api.createVisa(tk, {
          destinationCountry: n.countryCode, country: n.country, flag: n.flag,
          visaType: n.type, visaName: n.type, processingDays: n.processingDays,
          basePrice: n.basePrice, expressSurcharge: n.expressSurcharge,
          validityMonths: n.validityMonths, highlight: n.highlight, requiredDocs: n.requiredDocs,
        });
      }
      for (const n of next) {
        const old = prev.find((p) => p.id === n.id);
        if (old && JSON.stringify(old) !== JSON.stringify(n)) {
          await api.updateVisa(tk, n.id, {
            country: n.country, flag: n.flag, visaName: n.type,
            processingDays: n.processingDays, expressSurcharge: n.expressSurcharge,
            validityMonths: n.validityMonths, highlight: n.highlight,
            requiredDocs: n.requiredDocs,
          });
        }
      }
      const fresh = await api.listVisas(false);
      setVisas(fresh.visas.map(visaApiToMock));
    } catch (e) {
      alert(e instanceof ApiError ? `保存失败：${e.message}` : '保存失败');
      setVisas(prev);
    }
  }

  async function persistBundles(next: MockBundle[]) {
    const prev = bundles;
    setBundles(next);
    try {
      for (const old of prev) if (!next.find((n) => n.id === old.id)) await api.deleteBundle(tk, old.id);
      for (const n of next) if (!prev.find((p) => p.id === n.id)) {
        await api.createBundle(tk, {
          name: n.name, tagline: n.tagline, emoji: n.emoji,
          items: n.items, flightPax: n.flightPax,
          groundDiscount: n.groundDiscount, suitableFor: n.suitableFor,
          hotelRoomTypeId: n.hotelRoomTypeId ?? null,
          hotelNights: n.hotelRoomTypeId ? n.hotelNights ?? 1 : null,
          singleSupplementCnyPerNight: n.singleSupplementCnyPerNight ?? null,
          businessUpgradeCnyPerLeg: n.businessUpgradeCnyPerLeg ?? null,
          childSeatDiscountCnyPerPerson: n.childSeatDiscountCnyPerPerson ?? null,
          infantPriceCny: n.infantPriceCny ?? null,
          legs: n.legs ?? 2,
          blackoutDates: n.blackoutDates ?? [],
          defaultDepartDate: n.defaultDepartDate ?? null,
        });
      }
      for (const n of next) {
        const old = prev.find((p) => p.id === n.id);
        if (old && JSON.stringify(old) !== JSON.stringify(n)) {
          await api.updateBundle(tk, n.id, {
            name: n.name, tagline: n.tagline, emoji: n.emoji,
            items: n.items, flightPax: n.flightPax,
            groundDiscount: n.groundDiscount, suitableFor: n.suitableFor,
            hotelRoomTypeId: n.hotelRoomTypeId ?? null,
            hotelNights: n.hotelRoomTypeId ? n.hotelNights ?? 1 : null,
            singleSupplementCnyPerNight: n.singleSupplementCnyPerNight ?? null,
            businessUpgradeCnyPerLeg: n.businessUpgradeCnyPerLeg ?? null,
            childSeatDiscountCnyPerPerson: n.childSeatDiscountCnyPerPerson ?? null,
            infantPriceCny: n.infantPriceCny ?? null,
            legs: n.legs ?? 2,
            blackoutDates: n.blackoutDates ?? [],
            defaultDepartDate: n.defaultDepartDate ?? null,
            isActive: n.active,
          });
        }
      }
      const fresh = await api.listBundles(false);
      setBundles(fresh.bundles.map(bundleApiToMock));
    } catch (e) {
      alert(e instanceof ApiError ? `保存失败：${e.message}` : '保存失败');
      setBundles(prev);
    }
  }

  return (
    <div className="space-y-5">
      <section>
        <h1 className="page-title">产品管理</h1>
        <p className="page-sub">
          维护酒店、地面服务、签证三大基础产品，组合成套餐 (Bundle) 销售。
          套餐可让利定价，提升客单价和打包销售率。
        </p>
        {loading && <div className="mt-2 rounded-lg bg-canvas px-3 py-2 text-xs text-ink-muted">加载中…</div>}
        {error && <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
      </section>

      {/* Tabs */}
      <nav className="flex flex-wrap gap-1 border-b border-slate-200">
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
              className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition ${
                isSel
                  ? 'border-brand font-semibold text-brand'
                  : 'border-transparent text-ink-soft hover:border-slate-300 hover:text-ink'
              }`}
            >
              <span className="mr-1.5">{s.emoji}</span>
              {s.label}
              <span className={`ml-2 rounded-md px-1.5 py-0.5 text-xs nums ${isSel ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-ink-muted'}`}>{count}</span>
            </button>
          );
        })}
      </nav>

      {section === 'hotels' && <HotelsSection items={hotels} onChange={persistHotels} />}
      {section === 'transfers' && <TransfersSection items={transfers} onChange={persistTransfers} />}
      {section === 'visas' && <VisasSection items={visas} onChange={persistVisas} />}
      {section === 'bundles' && (
        <BundlesSection items={bundles} roomTypeOptions={roomTypeOptions} onChange={persistBundles} />
      )}
    </div>
  );
}

// ─── 酒店 ───────────────────────────────────────────────────────────
function HotelsSection({ items, onChange }: { items: MockHotel[]; onChange: (v: MockHotel[]) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<MockHotel | null>(null);
  return (
    <div className="space-y-3">
      <ActionBar active={items.length} onAdd={() => setShowForm(true)} addLabel="+ 新增酒店" />
      {editing && (
        <EditHotelForm
          hotel={editing}
          onCancel={() => setEditing(null)}
          onSave={(h) => { onChange(items.map((x) => x.id === h.id ? h : x)); setEditing(null); }}
        />
      )}
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
          <div key={h.id} className="card transition hover:shadow-pop">
            <div className="font-mono text-xs text-ink-muted">编号 {h.code ?? '—'} <span className="font-sans not-italic text-ink-muted">(系统自动生成)</span></div>
            <div className="flex items-start justify-between">
              <div className="text-3xl">{h.emoji}</div>
              <span className="badge-warning">{'★'.repeat(h.stars)} {h.stars}星</span>
            </div>
            <h3 className="mt-2 font-semibold text-ink">{h.name}</h3>
            <p className="text-xs text-ink-muted">{h.nameEn}</p>
            <p className="mt-1 text-xs text-ink-muted">📍 {h.area}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {h.amenities.slice(0, 3).map((a) => (
                <span key={a} className="badge-neutral">
                  {a}
                </span>
              ))}
            </div>
            <div className="mt-3 flex items-end justify-between border-t border-slate-100 pt-3">
              <div>
                <div className="text-xs text-ink-muted">每晚起</div>
                <div className="text-lg font-semibold text-ink nums">¥{h.basePrice}</div>
              </div>
              <div className="flex gap-3 text-xs">
                <button className="font-medium text-brand hover:text-brand-dark" onClick={() => setEditing(h)}>编辑</button>
                <button
                  className="text-ink-muted hover:text-rose-600"
                  onClick={() => { if (confirm(`删除 ${h.name}？`)) onChange(items.filter((x) => x.id !== h.id)); }}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 新增酒店：复用统一的富信息编辑器，预填一份合理空白模板 */
function NewHotelForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (h: MockHotel) => void;
}) {
  const blank: MockHotel = {
    id: 'h-' + Date.now(),
    name: '',
    nameEn: '',
    cityCode: 'DAD',
    area: '美溪海滩',
    address: '',
    stars: 4,
    basePrice: 880,
    rating: 4.5,
    reviewCount: 0,
    emoji: '🏨',
    photo: '',
    photos: [],
    amenities: ['免费 WiFi', '含早餐'],
    highlight: '',
    roomTypes: [{ name: '标准房', priceMult: 1, sleeps: 2, bedType: '双床或大床', maxAdults: 2, maxChildren: 1 }],
  };
  return (
    <HotelEditorForm hotel={blank} title="新增酒店" submitLabel="添加" onCancel={onCancel} onSave={onSubmit} />
  );
}

// ─── 接送 ───────────────────────────────────────────────────────────
function TransfersSection({ items, onChange }: { items: MockTransfer[]; onChange: (v: MockTransfer[]) => void }) {
  const [editing, setEditing] = useState<MockTransfer | null>(null);
  return (
    <div className="space-y-3">
      {editing && (
        <EditTransferForm
          transfer={editing}
          onCancel={() => setEditing(null)}
          onSave={(t) => { onChange(items.map((x) => x.id === t.id ? t : x)); setEditing(null); }}
        />
      )}
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
          <article key={t.id} className="card flex items-center gap-6 transition hover:shadow-pop">
            <div className="text-4xl">{t.emoji}</div>
            <div className="flex-1 min-w-0">
              <div className="font-mono text-xs text-ink-muted">编号 {t.code ?? '—'} <span className="font-sans not-italic text-ink-muted">(系统自动生成)</span></div>
              <h3 className="font-semibold text-ink">{t.name}</h3>
              <p className="text-sm text-ink-soft">{t.vehicleType}</p>
              <p className="mt-1 text-xs text-ink-muted">
                {t.originArea} → {t.destArea} · 最多 {t.capacity} 人 · {t.duration}
              </p>
            </div>
            <div className="text-right">
              <div className="text-xs text-ink-muted">起步价</div>
              <div className="text-xl font-semibold text-ink nums">¥{t.basePrice}</div>
              <div className="mt-1 flex justify-end gap-3 text-xs">
                <button className="font-medium text-brand hover:text-brand-dark" onClick={() => setEditing(t)}>编辑</button>
                <button
                  className="text-ink-muted hover:text-rose-600"
                  onClick={() => { if (confirm(`删除 ${t.name}？`)) onChange(items.filter((x) => x.id !== t.id)); }}
                >
                  删除
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

// ─── 签证 ───────────────────────────────────────────────────────────
function VisasSection({ items, onChange }: { items: MockVisa[]; onChange: (v: MockVisa[]) => void }) {
  const [editing, setEditing] = useState<MockVisa | null>(null);
  return (
    <div className="space-y-3">
      {editing && (
        <EditVisaForm
          visa={editing}
          onCancel={() => setEditing(null)}
          onSave={(v) => { onChange(items.map((x) => x.id === v.id ? v : x)); setEditing(null); }}
        />
      )}
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
          <div key={v.id} className="card transition hover:shadow-pop">
            <div className="font-mono text-xs text-ink-muted">编号 {v.code ?? '—'} <span className="font-sans not-italic text-ink-muted">(系统自动生成)</span></div>
            <div className="flex items-start justify-between">
              <span className="text-4xl">{v.flag}</span>
              <span className="badge-info">{v.processingDays} 天出签</span>
            </div>
            <h3 className="mt-2 font-semibold text-ink">
              {v.country} · {v.type}
            </h3>
            {v.highlight && (
              <p className="mt-1 text-xs font-medium text-emerald-700">★ {v.highlight}</p>
            )}
            <p className="mt-1 text-xs text-ink-muted">
              有效期 {v.validityMonths} 个月 · 材料 {v.requiredDocs.length} 项
            </p>
            <div className="mt-3 flex items-end justify-between border-t border-slate-100 pt-3">
              <div>
                <div className="text-xs text-ink-muted">办理费</div>
                <div className="text-lg font-semibold text-ink nums">¥{v.basePrice}</div>
              </div>
              <div className="flex gap-3 text-xs">
                <button className="font-medium text-brand hover:text-brand-dark" onClick={() => setEditing(v)}>编辑</button>
                <button
                  className="text-ink-muted hover:text-rose-600"
                  onClick={() => { if (confirm(`删除 ${v.country} · ${v.type}？`)) onChange(items.filter((x) => x.id !== v.id)); }}
                >
                  删除
                </button>
              </div>
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
  roomTypeOptions,
  onChange,
}: {
  items: MockBundle[];
  roomTypeOptions: RoomTypeOption[];
  onChange: (v: MockBundle[]) => void;
}) {
  const [showWizard, setShowWizard] = useState(false);
  const [editing, setEditing] = useState<MockBundle | null>(null);
  return (
    <div className="space-y-3">
      <ActionBar active={items.length} onAdd={() => setShowWizard(true)} addLabel="+ 新建套餐" />
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((b) => (
          <BundleCard
            key={b.id}
            bundle={b}
            onEdit={() => setEditing(b)}
            onToggle={() => onChange(items.map((x) => (x.id === b.id ? { ...x, active: !x.active } : x)))}
            onDelete={() => onChange(items.filter((x) => x.id !== b.id))}
          />
        ))}
      </div>
      {showWizard && (
        <NewBundleWizard
          roomTypeOptions={roomTypeOptions}
          onCancel={() => setShowWizard(false)}
          onSubmit={(b) => {
            onChange([b, ...items]);
            setShowWizard(false);
          }}
        />
      )}
      {editing && (
        <NewBundleWizard
          key={editing.id}
          roomTypeOptions={roomTypeOptions}
          initial={editing}
          onCancel={() => setEditing(null)}
          onSubmit={(b) => {
            // 更新既有套餐（保留 id + 顺序）；persistBundles 走 update 分支
            onChange(items.map((x) => (x.id === b.id ? b : x)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

const KIND_LABEL: Record<BundleItem['kind'], { label: string; color: string }> = {
  FLIGHT: { label: '机票', color: 'bg-sky-100 text-sky-700' },
  HOTEL: { label: '酒店', color: 'bg-purple-100 text-purple-700' },
  TRANSFER: { label: '地面服务', color: 'bg-pink-100 text-pink-700' },
  VISA: { label: '签证', color: 'bg-amber-100 text-amber-700' },
};

function BundleCard({
  bundle,
  onEdit,
  onToggle,
  onDelete,
}: {
  bundle: MockBundle;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const saving = bundle.listPrice - bundle.bundlePrice;
  const savingPct = bundle.listPrice > 0 ? (saving / bundle.listPrice) * 100 : 0;
  return (
    <article className={`card transition hover:shadow-pop ${bundle.active ? '' : 'opacity-60'}`}>
      <div className="font-mono text-xs text-ink-muted">编号 {bundle.code ?? '—'} <span className="font-sans not-italic text-ink-muted">(系统自动生成)</span></div>
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <span className="text-3xl">{bundle.emoji}</span>
          <div>
            <h3 className="font-semibold text-ink">{bundle.name}</h3>
            <p className="text-xs text-ink-soft mt-0.5">{bundle.tagline}</p>
            <p className="text-xs text-ink-muted mt-0.5">{bundle.suitableFor}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className={bundle.active ? 'badge-success' : 'badge-neutral'}>
            {bundle.active ? '在售' : '已停'}
          </span>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        {bundle.items.map((i, idx) => (
          <div key={idx} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`rounded-md px-1.5 py-0.5 font-medium ${KIND_LABEL[i.kind].color}`}>
                {KIND_LABEL[i.kind].label}
              </span>
              <span className="text-ink-soft truncate">{i.productName}</span>
            </div>
            <span className="text-ink-muted nums whitespace-nowrap">
              {i.qty} × ¥{i.unitPrice} = ¥{(i.qty * i.unitPrice).toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {bundle.hotelRoomType && (
        <div className="mt-2 text-xs text-ink-soft">
          🏨 关联酒店：{bundle.hotelRoomType.hotelName} · {bundle.hotelRoomType.name}
          {bundle.hotelNights ? `（${bundle.hotelNights} 晚）` : ''}
        </div>
      )}

      {(bundle.singleSupplementCnyPerNight != null || bundle.businessUpgradeCnyPerLeg != null) && (
        <div className="mt-1 text-xs text-ink-soft">
          {bundle.singleSupplementCnyPerNight != null && (
            <>🛏️ 单房差 ¥{bundle.singleSupplementCnyPerNight.toLocaleString()}/晚</>
          )}
          {bundle.singleSupplementCnyPerNight != null && bundle.businessUpgradeCnyPerLeg != null && ' · '}
          {bundle.businessUpgradeCnyPerLeg != null && (
            <>💺 升舱 ¥{bundle.businessUpgradeCnyPerLeg.toLocaleString()}/程
              {bundle.legs ? ` × ${bundle.legs} 段` : ''}</>
          )}
        </div>
      )}

      {(bundle.childSeatDiscountCnyPerPerson != null || bundle.infantPriceCny != null) && (
        <div className="mt-1 text-xs text-ink-soft">
          {bundle.childSeatDiscountCnyPerPerson != null && (
            <>🧒 占座儿童差价 −¥{bundle.childSeatDiscountCnyPerPerson.toLocaleString()}/人</>
          )}
          {bundle.childSeatDiscountCnyPerPerson != null && bundle.infantPriceCny != null && ' · '}
          {bundle.infantPriceCny != null && (
            <>👶 婴儿价 ¥{bundle.infantPriceCny.toLocaleString()}/人</>
          )}
        </div>
      )}

      <div className="mt-4 rounded-lg border border-slate-100 bg-canvas p-3">
        <div className="flex items-center justify-between text-sm text-ink-muted">
          <span>单买总价</span>
          <span className="line-through nums">¥{bundle.listPrice.toLocaleString()}</span>
        </div>
        <div className="mt-1 flex items-end justify-between">
          <span className="text-sm text-ink-soft">套餐价</span>
          <div>
            <span className="text-2xl font-semibold text-ink nums">¥{bundle.bundlePrice.toLocaleString()}</span>
            <span className="badge-danger ml-2">
              省 ¥{saving.toLocaleString()} ({savingPct.toFixed(0)}%)
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-3 text-xs">
        <button className="font-medium text-brand hover:text-brand-dark" onClick={onEdit}>
          编辑
        </button>
        <button className="font-medium text-ink-muted hover:text-brand" onClick={onToggle}>
          {bundle.active ? '停用' : '启用'}
        </button>
        <button className="text-ink-muted hover:text-rose-600" onClick={onDelete}>
          删除
        </button>
      </div>
    </article>
  );
}

function NewBundleWizard({
  roomTypeOptions,
  initial,
  onCancel,
  onSubmit,
}: {
  roomTypeOptions: RoomTypeOption[];
  /** 传入既有套餐 = 编辑模式（各字段预填）；缺省 = 新建 */
  initial?: MockBundle;
  onCancel: () => void;
  onSubmit: (b: MockBundle) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [tagline, setTagline] = useState(initial?.tagline ?? '');
  const [emoji, setEmoji] = useState(initial?.emoji ?? '🎁');
  const [suitableFor, setSuitableFor] = useState(initial?.suitableFor ?? '2 大人');
  const [hotelRoomTypeId, setHotelRoomTypeId] = useState(initial?.hotelRoomTypeId ?? '');
  const [hotelNights, setHotelNights] = useState<number | null>(initial?.hotelNights ?? 3);
  // 不可售日期（blackout，按出发日，单套餐粒度）+ 前台默认出发日
  const [blackoutDates, setBlackoutDates] = useState<BlackoutDateRow[]>(initial?.blackoutDates ?? []);
  const [defaultDepartDate, setDefaultDepartDate] = useState<string>(initial?.defaultDepartDate ?? '');
  // 自愿升级展示价（CNY；留空 = 前台不展示该升级项）
  const [singleSupplement, setSingleSupplement] = useState<number | null>(initial?.singleSupplementCnyPerNight ?? null);
  const [businessUpgrade, setBusinessUpgrade] = useState<number | null>(initial?.businessUpgradeCnyPerLeg ?? null);
  // 大人/小孩区分（CNY；留空 = 用服务端默认：占座儿童差价 ¥30、婴儿价 ¥0）
  const [childSeatDiscount, setChildSeatDiscount] = useState<number | null>(initial?.childSeatDiscountCnyPerPerson ?? null);
  const [infantPrice, setInfantPrice] = useState<number | null>(initial?.infantPriceCny ?? null);
  const [legs, setLegs] = useState<number | null>(initial?.legs ?? 2);
  // Local draft shape allowing null for in-progress numeric edits
  type DraftBundleItem = Omit<BundleItem, 'qty' | 'unitPrice'> & { qty: number | null; unitPrice: number | null };
  const [items, setItems] = useState<DraftBundleItem[]>(
    initial && initial.items.length > 0
      ? initial.items.map((it) => ({ kind: it.kind, productName: it.productName, qty: it.qty, unitPrice: it.unitPrice }))
      : [{ kind: 'HOTEL', productName: '岘港凯悦度假村 3 晚', qty: 3, unitPrice: 1880 }],
  );
  const [discount, setDiscount] = useState<number | null>(initial?.groundDiscount ?? 500);

  const listPrice = useMemo(() => items.reduce((s, i) => s + (i.qty ?? 0) * (i.unitPrice ?? 0), 0), [items]);
  const discountValue = Math.min(listPrice, Math.max(0, discount ?? 0));
  const bundlePrice = Math.max(0, listPrice - discountValue);
  const hotelLinkValid = !hotelRoomTypeId || (hotelNights != null && hotelNights >= 1 && hotelNights <= 30);
  const valid = name.length > 0 && items.length > 0 && bundlePrice > 0 && hotelLinkValid;

  const addItem = (kind: BundleItem['kind']) => {
    const presets: Record<BundleItem['kind'], DraftBundleItem> = {
      FLIGHT: { kind: 'HOTEL', productName: '（请从下方添加）', qty: 1, unitPrice: 0 },
      HOTEL: { kind: 'HOTEL', productName: '岘港凯悦度假村 1 晚', qty: 3, unitPrice: 1880 },
      TRANSFER: { kind: 'TRANSFER', productName: '岘港机场接送 商务车', qty: 2, unitPrice: 188 },
      VISA: { kind: 'VISA', productName: '越南 E-visa 30 天', qty: 2, unitPrice: 280 },
    };
    setItems([...items, presets[kind]]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-auto rounded-xl border border-slate-200 bg-white shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 px-5 py-3 backdrop-blur">
          <h2 className="text-lg font-semibold text-ink">{initial ? '编辑套餐' : '新建套餐'}</h2>
          <button className="btn-ghost px-2 py-1 text-xl leading-none" onClick={onCancel}>×</button>
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
          <div className="grid gap-3 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className="label">关联酒店房型（房控板计入套餐占房）</label>
              <select className="input" value={hotelRoomTypeId} onChange={(e) => setHotelRoomTypeId(e.target.value)}>
                <option value="">不关联酒店</option>
                {roomTypeOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-muted">找不到酒店？在 产品管理 › 酒店 里添加/编辑（含介绍、图片、房型）。</p>
            </div>
            {hotelRoomTypeId && (
              <div>
                <label className="label">晚数</label>
                <NumberInput min={1} max={30} className="input" value={hotelNights} onChange={(n) => setHotelNights(n)} integerOnly />
              </div>
            )}
            <div>
              <label className="label">默认出发日（可选）</label>
              <input
                type="date"
                className="input"
                value={defaultDepartDate}
                onChange={(e) => setDefaultDepartDate(e.target.value)}
              />
              <p className="mt-1 text-xs text-ink-muted">前台默认带出的出发日，不影响可售判定。留空 = 无默认。</p>
            </div>
          </div>

          <BundleBlackoutEditor value={blackoutDates} onChange={setBlackoutDates} />

          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="label">单房差 (¥/晚)</label>
              <NumberInput
                min={0}
                max={1000000}
                className="input"
                placeholder="留空 = 用默认 ¥80"
                value={singleSupplement}
                onChange={(n) => setSingleSupplement(n)}
              />
            </div>
            <div>
              <label className="label">升舱商务 (¥/程)</label>
              <NumberInput
                min={0}
                max={1000000}
                className="input"
                placeholder="留空 = 用默认 ¥700"
                value={businessUpgrade}
                onChange={(n) => setBusinessUpgrade(n)}
              />
            </div>
            <div>
              <label className="label">航段数（来回 = 2 / 单程 = 1）</label>
              <NumberInput
                min={1}
                max={8}
                className="input"
                value={legs}
                onChange={(n) => setLegs(n)}
                integerOnly
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">儿童差价 (¥/人，占座儿童比成人便宜)</label>
              <NumberInput
                min={0}
                max={1000000}
                className="input"
                placeholder="留空 = 用默认 ¥30"
                value={childSeatDiscount}
                onChange={(n) => setChildSeatDiscount(n)}
                integerOnly
              />
            </div>
            <div>
              <label className="label">婴儿价 (¥/人，不占座婴儿)</label>
              <NumberInput
                min={0}
                max={1000000}
                className="input"
                placeholder="留空 = 用默认 ¥0"
                value={infantPrice}
                onChange={(n) => setInfantPrice(n)}
                integerOnly
              />
            </div>
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
                <div key={idx} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-canvas p-2">
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
                  <NumberInput
                    min={1}
                    className="input w-16 text-xs"
                    value={it.qty}
                    onChange={(n) => {
                      const next = [...items];
                      next[idx] = { ...it, qty: n };
                      setItems(next);
                    }}
                    integerOnly
                  />
                  <NumberInput
                    min={0}
                    className="input w-24 text-xs"
                    value={it.unitPrice}
                    onChange={(n) => {
                      const next = [...items];
                      next[idx] = { ...it, unitPrice: n };
                      setItems(next);
                    }}
                  />
                  <span className="text-xs text-ink-muted w-20 text-right nums">
                    ¥{((it.qty ?? 0) * (it.unitPrice ?? 0)).toLocaleString()}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-ink-muted hover:text-rose-600"
                    onClick={() => setItems(items.filter((_, i) => i !== idx))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-slate-100 bg-canvas p-3 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-soft">单买总价</span>
              <span className="font-medium text-ink nums">¥{listPrice.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-soft">
                让利金额
                <span className="ml-1 text-xs text-ink-muted">(单买总价 − 套餐价)</span>
              </span>
              <NumberInput
                min={0}
                max={listPrice}
                className="input w-32 text-right"
                value={discount}
                onChange={(n) => setDiscount(n)}
              />
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 pt-2">
              <span className="text-sm text-ink-soft">套餐价</span>
              <span className="text-2xl font-semibold text-ink nums">¥{bundlePrice.toLocaleString()}</span>
            </div>
            {discountValue > 0 && (
              <div className="text-right text-xs text-emerald-700">
                客户节省 ¥{discountValue.toLocaleString()}
                {listPrice > 0 ? `（${((discountValue / listPrice) * 100).toFixed(0)}%）` : ''}
              </div>
            )}
            {!valid && (
              <p className="text-xs text-rose-600">⚠️ 请填写套餐名 + 至少 1 个产品 + 套餐价 &gt; 0</p>
            )}
            {!hotelLinkValid && (
              <p className="text-xs text-rose-600">⚠️ 已关联酒店房型时，晚数需为 1–30 的整数</p>
            )}
          </div>

          <div className="flex justify-end gap-3">
            <button className="btn-secondary" onClick={onCancel}>取消</button>
            <button
              className="btn-primary"
              disabled={!valid}
              onClick={() =>
                onSubmit({
                  ...(initial ?? {}),
                  id: initial?.id ?? 'b-' + Date.now(),
                  name,
                  tagline: tagline || '新建套餐',
                  emoji,
                  items: items.map((it) => ({
                    ...it,
                    qty: Math.max(1, it.qty ?? 1),
                    unitPrice: it.unitPrice ?? 0,
                  })),
                  listPrice,
                  bundlePrice,
                  groundDiscount: discountValue,
                  flightPax: 2,
                  suitableFor,
                  active: initial?.active ?? true,
                  hotelRoomTypeId: hotelRoomTypeId || null,
                  hotelNights: hotelRoomTypeId ? hotelNights : null,
                  singleSupplementCnyPerNight: singleSupplement,
                  businessUpgradeCnyPerLeg: businessUpgrade,
                  childSeatDiscountCnyPerPerson: childSeatDiscount,
                  infantPriceCny: infantPrice,
                  legs: legs ?? 2,
                  // 仅提交填了日期的封盘行；reason 去空格，空则省略
                  blackoutDates: blackoutDates
                    .filter((b) => b.date)
                    .map((b) => ({
                      date: b.date,
                      ...(b.reason?.trim() ? { reason: b.reason.trim() } : {}),
                    })),
                  defaultDepartDate: defaultDepartDate || null,
                })
              }
            >
              {initial ? '保存修改' : '创建套餐'}
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
      <p className="text-sm text-ink-muted">共 <span className="nums font-medium text-ink-soft">{active}</span> 项</p>
      <button className="btn-primary" onClick={onAdd}>{addLabel}</button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 编辑表单：酒店 / 接送 / 签证
// ═══════════════════════════════════════════════════════════════

function EditHotelForm({ hotel, onCancel, onSave }: { hotel: MockHotel; onCancel: () => void; onSave: (h: MockHotel) => void }) {
  return (
    <HotelEditorForm
      hotel={hotel}
      title={`编辑酒店 · ${hotel.name}`}
      submitLabel="保存修改"
      onCancel={onCancel}
      onSave={onSave}
    />
  );
}

/**
 * 统一的酒店富信息编辑器（新增 / 编辑共用）。
 * 暴露全部后端支持的字段：中文名 / 英文名 / 城市码 / 区域 / 地址 / 星级 / 每晚起价 /
 * 详细介绍 / 多张图片 / 设施标签 / 房型（含床型·人数·价格·系数）。
 */
function HotelEditorForm({
  hotel,
  title,
  submitLabel,
  onCancel,
  onSave,
}: {
  hotel: MockHotel;
  title: string;
  submitLabel: string;
  onCancel: () => void;
  onSave: (h: MockHotel) => void;
}) {
  const [name, setName] = useState(hotel.name);
  const [nameEn, setNameEn] = useState(hotel.nameEn);
  const [cityCode, setCityCode] = useState(hotel.cityCode || 'DAD');
  const [area, setArea] = useState(hotel.area);
  const [address, setAddress] = useState(hotel.address ?? '');
  const [stars, setStars] = useState<3 | 4 | 5>(hotel.stars);
  const [basePrice, setBasePrice] = useState<number | null>(hotel.basePrice);
  const [emoji, setEmoji] = useState(hotel.emoji);
  const [highlight, setHighlight] = useState(hotel.highlight);
  // 图片：优先 photos[]，回退单张 photo；保证至少 1 行可填
  const [photos, setPhotos] = useState<string[]>(
    hotel.photos && hotel.photos.length > 0 ? hotel.photos : hotel.photo ? [hotel.photo] : [''],
  );
  const [amenities, setAmenities] = useState<string[]>(hotel.amenities);
  const [roomTypes, setRoomTypes] = useState<HotelRoomType[]>(
    hotel.roomTypes.length > 0 ? hotel.roomTypes : [{ name: '', priceMult: 1, sleeps: 2, bedType: '', maxAdults: 2, maxChildren: 1 }],
  );
  const [saved, setSaved] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPhotos = photos.map((p) => p.trim()).filter(Boolean);
    const cleanRooms = roomTypes
      .map((rt) => ({ ...rt, name: rt.name.trim(), bedType: rt.bedType.trim() }))
      .filter((rt) => rt.name);
    const updated: MockHotel = {
      ...hotel,
      name: name.trim(),
      nameEn: nameEn.trim(),
      cityCode,
      area: area.trim(),
      address: address.trim(),
      stars,
      basePrice: basePrice ?? 0,
      emoji: emoji.trim() || '🏨',
      highlight: highlight.trim(),
      photo: cleanPhotos[0] ?? '',
      photos: cleanPhotos,
      amenities: amenities.map((a) => a.trim()).filter(Boolean),
      roomTypes: cleanRooms,
    };
    setSaved(true);
    setTimeout(() => onSave(updated), 600);
  };

  return (
    <section className="card border-brand-200 bg-brand-50/40">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-ink">{title}</h3>
        <button type="button" className="btn-ghost px-2 py-1 text-xl leading-none" onClick={onCancel}>×</button>
      </div>
      <form className="mt-3 space-y-4" onSubmit={handleSubmit}>
        {/* 基本信息 */}
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="label text-xs">中文名 *</label>
            <input required className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label text-xs">英文名</label>
            <input className="input" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
          <div>
            <label className="label text-xs">Emoji 图标</label>
            <input className="input" maxLength={4} value={emoji} onChange={(e) => setEmoji(e.target.value)} />
          </div>
          <div>
            <label className="label text-xs">城市代码</label>
            <select className="input" value={cityCode} onChange={(e) => setCityCode(e.target.value)}>
              <option value="DAD">DAD 岘港</option>
              <option value="HOA">HOA 会安</option>
              <option value="BAN">BAN 巴拿山</option>
            </select>
          </div>
          <div>
            <label className="label text-xs">区域</label>
            <input className="input" value={area} onChange={(e) => setArea(e.target.value)} placeholder="美溪海滩 / 山茶半岛 / 市中心" />
          </div>
          <div>
            <label className="label text-xs">星级</label>
            <select className="input" value={stars} onChange={(e) => setStars(Number(e.target.value) as 3 | 4 | 5)}>
              <option value={3}>三星</option>
              <option value={4}>四星</option>
              <option value={5}>五星</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label text-xs">详细地址</label>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="如 越南岘港市 Vo Nguyen Giap 路 5 号" />
          </div>
          <div>
            <label className="label text-xs">每晚起价 (¥)</label>
            <NumberInput min={0} className="input" value={basePrice} onChange={(n) => setBasePrice(n)} />
          </div>
        </div>

        {/* 详细介绍 / 亮点 */}
        <div>
          <label className="label text-xs">详细介绍 / 亮点</label>
          <textarea
            className="input min-h-[88px] resize-y"
            value={highlight}
            onChange={(e) => setHighlight(e.target.value)}
            placeholder="酒店卖点、地理位置、特色服务，可多行。前台/套餐里会展示给客户。"
          />
        </div>

        {/* 图片（多张 URL，第一张 = 封面） */}
        <PhotoListEditor photos={photos} onChange={setPhotos} />

        {/* 设施标签 */}
        <AmenityChipsEditor amenities={amenities} onChange={setAmenities} />

        {/* 房型管理 */}
        <RoomTypesEditor roomTypes={roomTypes} onChange={setRoomTypes} />

        {saved && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">保存中…</div>}

        <div className="flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary">{submitLabel}</button>
        </div>
      </form>
    </section>
  );
}

/** 多张图片 URL 编辑（第一张为封面，可增删，URL 制无上传） */
function PhotoListEditor({ photos, onChange }: { photos: string[]; onChange: (v: string[]) => void }) {
  const setAt = (idx: number, val: string) => onChange(photos.map((p, i) => (i === idx ? val : p)));
  const removeAt = (idx: number) => {
    const next = photos.filter((_, i) => i !== idx);
    onChange(next.length > 0 ? next : ['']);
  };
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="label text-xs !mb-0">图片 URL（第一张为封面）</label>
        <button type="button" className="text-xs font-medium text-brand hover:text-brand-dark" onClick={() => onChange([...photos, ''])}>
          + 添加图片
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {photos.map((p, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <span className={`w-12 shrink-0 text-center text-xs ${idx === 0 ? 'font-medium text-brand' : 'text-ink-muted'}`}>
              {idx === 0 ? '封面' : `#${idx + 1}`}
            </span>
            <input
              className="input flex-1"
              value={p}
              onChange={(e) => setAt(idx, e.target.value)}
              placeholder="https://…（粘贴图片链接）"
            />
            {p.trim() && (
              <img src={p} alt="" className="h-9 w-9 shrink-0 rounded object-cover" onError={(e) => { (e.currentTarget.style.display = 'none'); }} />
            )}
            <button
              type="button"
              className="shrink-0 text-xs text-ink-muted hover:text-rose-600"
              onClick={() => removeAt(idx)}
              aria-label="删除图片"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 设施标签编辑（chip 增删，回车 / 逗号添加） */
function AmenityChipsEditor({ amenities, onChange }: { amenities: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const tags = draft.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (tags.length === 0) return;
    onChange(Array.from(new Set([...amenities, ...tags])));
    setDraft('');
  };
  return (
    <div>
      <label className="label text-xs">设施</label>
      <div className="flex flex-wrap items-center gap-1.5">
        {amenities.map((a, idx) => (
          <span key={`${a}-${idx}`} className="badge-neutral inline-flex items-center gap-1">
            {a}
            <button
              type="button"
              className="text-ink-muted hover:text-rose-600"
              onClick={() => onChange(amenities.filter((_, i) => i !== idx))}
              aria-label={`删除 ${a}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          className="input flex-1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="输入设施后回车，如 私人海滩 / 泳池 / 含早餐"
        />
        <button type="button" className="btn-secondary" onClick={add}>添加</button>
      </div>
    </div>
  );
}

/** 房型管理：可增删行，每行 房型名 / 床型 / 人数 / 每晚价 / 价格系数 */
function RoomTypesEditor({ roomTypes, onChange }: { roomTypes: HotelRoomType[]; onChange: (v: HotelRoomType[]) => void }) {
  const setAt = (idx: number, patch: Partial<HotelRoomType>) =>
    onChange(roomTypes.map((rt, i) => (i === idx ? { ...rt, ...patch } : rt)));
  const removeAt = (idx: number) => onChange(roomTypes.filter((_, i) => i !== idx));
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="label text-xs !mb-0">房型管理</label>
        <button
          type="button"
          className="text-xs font-medium text-brand hover:text-brand-dark"
          onClick={() => onChange([...roomTypes, { name: '', priceMult: 1, sleeps: 2, bedType: '', maxAdults: 2, maxChildren: 1 }])}
        >
          + 添加房型
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {roomTypes.map((rt, idx) => (
          <div key={idx} className="grid grid-cols-2 items-end gap-2 rounded-lg border border-slate-200 bg-canvas p-2 md:grid-cols-16">
            <div className="col-span-2 md:col-span-3">
              <label className="label text-xs">房型名 *</label>
              <input className="input" value={rt.name} onChange={(e) => setAt(idx, { name: e.target.value })} placeholder="海景大床房" />
            </div>
            <div className="col-span-2 md:col-span-3">
              <label className="label text-xs">床型</label>
              <input className="input" value={rt.bedType} onChange={(e) => setAt(idx, { bedType: e.target.value })} placeholder="1 张大床 · 海景" />
            </div>
            <div className="md:col-span-2">
              <label className="label text-xs">可住人数</label>
              <NumberInput min={1} max={20} className="input" value={rt.sleeps} onChange={(n) => setAt(idx, { sleeps: n ?? 1 })} integerOnly />
            </div>
            <div className="md:col-span-2">
              <label className="label text-xs">可住大人</label>
              <NumberInput min={1} max={20} className="input" value={rt.maxAdults ?? 2} onChange={(n) => setAt(idx, { maxAdults: n ?? 2 })} integerOnly />
            </div>
            <div className="md:col-span-2">
              <label className="label text-xs">可加小孩</label>
              <NumberInput min={0} max={20} className="input" value={rt.maxChildren ?? 1} onChange={(n) => setAt(idx, { maxChildren: n ?? 0 })} integerOnly />
            </div>
            <div className="md:col-span-2">
              <label className="label text-xs">价格系数</label>
              <NumberInput min={0.1} max={20} className="input" value={rt.priceMult} onChange={(n) => setAt(idx, { priceMult: n ?? 1 })} />
            </div>
            <div className="md:col-span-2 flex items-center justify-end pb-1">
              <button type="button" className="text-xs text-ink-muted hover:text-rose-600" onClick={() => removeAt(idx)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1 text-xs text-ink-muted">每晚价 = 酒店每晚起价 × 价格系数（如标准房 1.0、海景房 1.15）。</p>
    </div>
  );
}

function EditTransferForm({ transfer, onCancel, onSave }: { transfer: MockTransfer; onCancel: () => void; onSave: (t: MockTransfer) => void }) {
  const [form, setForm] = useState({ ...transfer });
  const [basePrice, setBasePrice] = useState<number | null>(transfer.basePrice);
  const [capacity, setCapacity] = useState<number | null>(transfer.capacity);
  const [featuresText, setFeaturesText] = useState(transfer.features.join(', '));
  const [saved, setSaved] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const updated: MockTransfer = {
      ...form,
      basePrice: basePrice ?? 0,
      capacity: capacity ?? 1,
      features: featuresText.split(',').map(s => s.trim()).filter(Boolean),
    };
    setSaved(true);
    setTimeout(() => onSave(updated), 800);
  };

  return (
    <section className="card border-brand-200 bg-brand-50/40">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-ink">编辑地面服务 · {transfer.name}</h3>
        <button type="button" className="btn-ghost px-2 py-1 text-xl leading-none" onClick={onCancel}>×</button>
      </div>
      <form className="mt-3 grid gap-3 md:grid-cols-3" onSubmit={handleSubmit}>
        <div className="md:col-span-2">
          <label className="label text-xs">服务名称 *</label>
          <input required className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="label text-xs">起步价 (¥)</label>
          <NumberInput min={0} className="input" value={basePrice} onChange={(n) => setBasePrice(n)} />
        </div>
        <div className="md:col-span-2">
          <label className="label text-xs">车型描述</label>
          <input className="input" value={form.vehicleType} onChange={(e) => setForm({ ...form, vehicleType: e.target.value })} />
        </div>
        <div>
          <label className="label text-xs">最大乘客数</label>
          <NumberInput min={1} max={20} className="input" value={capacity} onChange={(n) => setCapacity(n)} integerOnly />
        </div>
        <div>
          <label className="label text-xs">出发区域</label>
          <input className="input" value={form.originArea} onChange={(e) => setForm({ ...form, originArea: e.target.value })} />
        </div>
        <div>
          <label className="label text-xs">目的区域</label>
          <input className="input" value={form.destArea} onChange={(e) => setForm({ ...form, destArea: e.target.value })} />
        </div>
        <div>
          <label className="label text-xs">行程时长</label>
          <input className="input" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} />
        </div>
        <div className="md:col-span-3">
          <label className="label text-xs">卖点（逗号分隔）</label>
          <input className="input" value={featuresText} onChange={(e) => setFeaturesText(e.target.value)} placeholder="中文司机, 免费等候 60 分钟" />
        </div>
        <div className="md:col-span-2">
          <label className="label text-xs">图片 URL</label>
          <input className="input" value={form.photo} onChange={(e) => setForm({ ...form, photo: e.target.value })} />
        </div>
        <div>
          <label className="label text-xs">Emoji</label>
          <input className="input" maxLength={4} value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} />
        </div>

        {saved && <div className="md:col-span-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">保存中…</div>}

        <div className="md:col-span-3 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary">保存修改</button>
        </div>
      </form>
    </section>
  );
}

function EditVisaForm({ visa, onCancel, onSave }: { visa: MockVisa; onCancel: () => void; onSave: (v: MockVisa) => void }) {
  const [form, setForm] = useState({ ...visa, highlight: visa.highlight ?? '' });
  const [basePrice, setBasePrice] = useState<number | null>(visa.basePrice);
  const [expressSurcharge, setExpressSurcharge] = useState<number | null>(visa.expressSurcharge);
  const [processingDays, setProcessingDays] = useState<number | null>(visa.processingDays);
  const [validityMonths, setValidityMonths] = useState<number | null>(visa.validityMonths);
  const [docsText, setDocsText] = useState(visa.requiredDocs.join(', '));
  const [saved, setSaved] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const updated: MockVisa = {
      ...form,
      basePrice: basePrice ?? 0,
      expressSurcharge: expressSurcharge ?? 0,
      processingDays: processingDays ?? 1,
      validityMonths: validityMonths ?? 1,
      highlight: form.highlight || undefined,
      requiredDocs: docsText.split(',').map(s => s.trim()).filter(Boolean),
    };
    setSaved(true);
    setTimeout(() => onSave(updated), 800);
  };

  return (
    <section className="card border-brand-200 bg-brand-50/40">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-ink">编辑签证 · {visa.country} {visa.type}</h3>
        <button type="button" className="btn-ghost px-2 py-1 text-xl leading-none" onClick={onCancel}>×</button>
      </div>
      <form className="mt-3 grid gap-3 md:grid-cols-3" onSubmit={handleSubmit}>
        <div>
          <label className="label text-xs">目的国 *</label>
          <input required className="input" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
        </div>
        <div>
          <label className="label text-xs">国家代码</label>
          <input className="input" value={form.countryCode} onChange={(e) => setForm({ ...form, countryCode: e.target.value })} maxLength={3} />
        </div>
        <div>
          <label className="label text-xs">国旗 Emoji</label>
          <input className="input" maxLength={4} value={form.flag} onChange={(e) => setForm({ ...form, flag: e.target.value })} />
        </div>
        <div className="md:col-span-3">
          <label className="label text-xs">签证类型 *</label>
          <input required className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} placeholder="如 电子签证 E-visa · 30 天单次" />
        </div>
        <div>
          <label className="label text-xs">办理费 (¥)</label>
          <NumberInput min={0} className="input" value={basePrice} onChange={(n) => setBasePrice(n)} />
        </div>
        <div>
          <label className="label text-xs">加急附加费 (¥)</label>
          <NumberInput min={0} className="input" value={expressSurcharge} onChange={(n) => setExpressSurcharge(n)} />
        </div>
        <div>
          <label className="label text-xs">出签天数</label>
          <NumberInput min={1} max={60} className="input" value={processingDays} onChange={(n) => setProcessingDays(n)} integerOnly />
        </div>
        <div>
          <label className="label text-xs">有效期 (月)</label>
          <NumberInput min={1} max={120} className="input" value={validityMonths} onChange={(n) => setValidityMonths(n)} integerOnly />
        </div>
        <div className="md:col-span-2">
          <label className="label text-xs">卖点（如"最热销"）</label>
          <input className="input" value={form.highlight} onChange={(e) => setForm({ ...form, highlight: e.target.value })} />
        </div>
        <div className="md:col-span-3">
          <label className="label text-xs">所需材料（逗号分隔）</label>
          <input className="input" value={docsText} onChange={(e) => setDocsText(e.target.value)} placeholder="护照首页扫描件, 2寸白底照片" />
        </div>

        {saved && <div className="md:col-span-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">保存中…</div>}

        <div className="md:col-span-3 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary">保存修改</button>
        </div>
      </form>
    </section>
  );
}
