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
import { api, ApiError, type Hotel, type Transfer as ApiTransfer, type Visa as ApiVisa, type Bundle as ApiBundle, type AdminFlight, type BundleFlightRef } from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';
import { BundleBlackoutEditor, type BlackoutDateRow } from '../components/BundleBlackoutEditor';

// 0702 反馈 1：服务内容 / 单次最多停留天数 —— MockVisa/MockBundle（lib/mockData.ts）暂未声明这两个字段，
// 用本页局部扩展类型承接，不改共享 mock 类型定义。
type MockVisaWithStayDays = MockVisa & { stayDays?: number | null };
type MockBundleWithServiceNotes = MockBundle & { serviceNotes?: string | null };

type Section = 'hotels' | 'transfers' | 'visas' | 'bundles';

const SECTIONS: { key: Section; label: string; emoji: string }[] = [
  { key: 'hotels', label: '酒店', emoji: '🏨' },
  { key: 'transfers', label: '地面服务', emoji: '🚐' },
  { key: 'visas', label: '签证', emoji: '🛂' },
  { key: 'bundles', label: '套餐 / Bundle', emoji: '🎁' },
];

/** 列表行只保留在售：软删除（isActive=false）后端仍会返回，前端需过滤掉，否则删了又被拉回。 */
function activeOnly<T extends { isActive?: boolean }>(rows: T[]): T[] {
  return rows.filter((r) => r.isActive !== false);
}

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

function visaApiToMock(v: ApiVisa): MockVisaWithStayDays {
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
    // 单次入境最多可停留天数（订单详情行程单「最多可停留 X 天」用）
    stayDays: v.stayDays,
  };
}

function bundleApiToMock(b: ApiBundle): MockBundleWithServiceNotes {
  const items = (b.items as BundleItem[]) ?? [];
  // 原价参考 = 各项合计（机票行 unitPrice 在 DB 为 0 → 此处仅地面参考；真实全包价含实时机票，在前台/下单时算）。
  // 套餐价 = 原价 ×(1 − discountPct/100)；折扣是套餐唯一口径。
  const discountPct = b.discountPct ?? 0;
  // 原价 = 含当前最低机票的全包原价（后端 originalAllInCny）；旧数据/无机票估值时回退 items 合计。
  // 用它做"单买总价/划线价"，确保含机票（修复套餐卡只显示地面价 ¥350 的问题）。
  const originalAllIn = b.originalAllInCny ?? items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    tagline: b.tagline ?? '',
    // 服务内容（订单详情行程单「服务内容」板块；运营在向导里填，每行一条）
    serviceNotes: b.serviceNotes ?? '',
    emoji: b.emoji ?? '🎁',
    items,
    listPrice: originalAllIn,
    bundlePrice: Math.round(originalAllIn * (1 - discountPct / 100)),
    discountPct,
    originalAllInCny: b.originalAllInCny,
    originalPerPaxCny: b.originalPerPaxCny,
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
    selfVisaDeductCny: b.selfVisaDeductCny ?? null,
    infantPriceCny: b.infantPriceCny,
    legs: b.legs,
    blackoutDates: b.blackoutDates ?? [],
    defaultDepartDate: b.defaultDepartDate ?? null,
    outboundFlight: b.outboundFlight ?? null,
    returnFlight: b.returnFlight ?? null,
  };
}

/**
 * 从已有套餐反推「当前最低来回机票 / 人」(CNY)：后端给的 originalAllInCny = 地面 + 机票×flightPax，
 * 故 机票 = (originalAllInCny − 地面) / flightPax。新建套餐用它把「想卖的价格」换算成折扣%。
 * 取第一个能算出正值的套餐；都算不出 → null（新建时退化为仅地面口径）。
 */
function deriveFlightRefRoundTrip(bundles: MockBundle[]): number | null {
  for (const b of bundles) {
    if (b.originalAllInCny == null || !b.flightPax) continue;
    const ground = b.items
      .filter((i) => i.kind !== 'FLIGHT')
      .reduce((s, i) => s + (i.qty ?? 0) * (i.unitPrice ?? 0), 0);
    const ref = Math.round((b.originalAllInCny - ground) / b.flightPax);
    if (ref > 0) return ref;
  }
  return null;
}

/**
 * 单套餐机票口径（展示用）：从 originalAllInCny 反推「每人来回机票」= (原价 − 地面) / flightPax，
 * 来回价再对半拆成去程 / 回程（去回两程等价，各占一半，向下取整、回程补差保证 去+回=来回）。
 * 只做展示，不改任何定价数学。算不出正值（缺 originalAllInCny / 无机票项）→ null。
 */
function bundleFlightRoundTrip(
  b: MockBundle,
): { roundTrip: number; outbound: number; inbound: number } | null {
  // 防御：items 非数组等畸形形状（历史脏数据）时安全短路，不让整个套餐列表因一条坏数据崩溃。
  if (!Array.isArray(b.items)) return null;
  const hasFlight = b.items.some((i) => i.kind === 'FLIGHT');
  if (!hasFlight || b.originalAllInCny == null || !b.flightPax) return null;
  const ground = b.items
    .filter((i) => i.kind !== 'FLIGHT')
    .reduce((s, i) => s + (i.qty ?? 0) * (i.unitPrice ?? 0), 0);
  const roundTrip = Math.round((b.originalAllInCny - ground) / b.flightPax);
  if (roundTrip <= 0) return null;
  const outbound = Math.floor(roundTrip / 2);
  const inbound = roundTrip - outbound; // 补差，保证 去+回 = 来回
  return { roundTrip, outbound, inbound };
}

/**
 * 住宿晚数唯一真源（持久化侧）：含 HOTEL 项的套餐，hotelNights 取套餐自身的
 * hotelNights，回退到首个 HOTEL 项的 qty，再回退 1；不含 HOTEL 项则为 null。
 * 与是否关联房型无关 —— 修复旧逻辑「未关联房型就把 hotelNights 置 null」。
 */
function persistedHotelNights(b: MockBundle): number | null {
  const firstHotelQty = (b.items as BundleItem[]).find((it) => it.kind === 'HOTEL')?.qty ?? null;
  if (firstHotelQty == null) return null;
  return b.hotelNights ?? firstHotelQty ?? 1;
}

/** 套餐表单的酒店房型下拉选项（酒店名 · 房型名，value = roomTypeId） */
interface RoomTypeOption {
  id: string;
  label: string;
  /** 房型整间夜价（¥/晚，= 酒店每晚起价 × 价格系数，与后端 HotelRoomType.basePrice 落库口径一致）；只读展示用 */
  nightlyPriceCny: number;
}

/** 套餐表单的航班号下拉选项（航班号 · 航线，value = flightId）；保留航班号/航线字段以便提交时回建引用 */
interface FlightOption {
  id: string;
  label: string;
  flightNumber: string;
  originCode: string;
  destinationCode: string;
}

/** 航班号下拉标签：`QH9589 · MFM→DAD`。只列在售航班；value = flight.id。 */
function flightsToOptions(flights: AdminFlight[]): FlightOption[] {
  return flights
    .filter((f) => f.isActive)
    .map((f) => ({
      id: f.id,
      label: `${f.flightNumber} · ${f.originCode}→${f.destinationCode}`,
      flightNumber: f.flightNumber,
      originCode: f.originCode,
      destinationCode: f.destinationCode,
    }));
}

/**
 * 由选中的 flightId 回建套餐航班号引用（BundleFlightRef）：
 * 优先用当前下拉选项；选项里没有（如航班停用了但套餐仍绑着）则回退已绑引用；都没有 → null。
 */
function resolveFlightRef(
  flightId: string,
  options: FlightOption[],
  fallback: BundleFlightRef | null | undefined,
): BundleFlightRef | null {
  if (!flightId) return null;
  const opt = options.find((o) => o.id === flightId);
  if (opt) {
    return {
      id: opt.id,
      flightNumber: opt.flightNumber,
      originCode: opt.originCode,
      destinationCode: opt.destinationCode,
    };
  }
  return fallback && fallback.id === flightId ? fallback : null;
}

/** 航班号引用 → 展示标签：`QH9589 · MFM→DAD`（套餐卡/表单展示已绑航班用）。 */
function flightRefLabel(ref: BundleFlightRef | null | undefined): string | null {
  if (!ref) return null;
  return `${ref.flightNumber} · ${ref.originCode}→${ref.destinationCode}`;
}

export function ProductsPage() {
  const tokens = useAuth((s) => s.tokens);
  const [section, setSection] = useState<Section>('hotels');
  const [hotels, setHotels] = useState<MockHotel[]>([]);
  const [transfers, setTransfers] = useState<MockTransfer[]>([]);
  const [visas, setVisas] = useState<MockVisaWithStayDays[]>([]);
  const [bundles, setBundles] = useState<MockBundleWithServiceNotes[]>([]);
  const [roomTypeOptions, setRoomTypeOptions] = useState<RoomTypeOption[]>([]);
  // 套餐可绑定的航班号选项（去程/回程下拉用）。仅在售航班。
  const [flightOptions, setFlightOptions] = useState<FlightOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tk = tokens?.accessToken ?? '';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.listHotels(false),
      api.listTransfers(false),
      api.listVisas(false),
      api.listBundles(false),
      api.listAllFlights(tk).catch(() => ({ flights: [] as AdminFlight[] })),
    ])
      .then(([h, t, v, b, f]) => {
        if (cancelled) return;
        const activeHotels = activeOnly(h.hotels);
        setHotels(activeHotels.map(hotelApiToMock));
        setTransfers(activeOnly(t.transfers).map(transferApiToMock));
        setVisas(activeOnly(v.visas).map(visaApiToMock));
        setBundles(activeOnly(b.bundles).map(bundleApiToMock));
        setRoomTypeOptions(
          activeHotels.flatMap((ht) =>
            ht.roomTypes.map((rt) => ({
              id: rt.id,
              label: `${ht.name} · ${rt.name}`,
              // 整间夜价 = 房型自身 basePrice（服务端权威取价源，与 hotelRoomType.nightlyPriceCny 落库口径一致）。
              nightlyPriceCny: Math.round(Number(rt.basePrice)),
            })),
          ),
        );
        setFlightOptions(flightsToOptions(f.flights));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setHotels(activeOnly(fresh.hotels).map(hotelApiToMock));
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
      setTransfers(activeOnly(fresh.transfers).map(transferApiToMock));
    } catch (e) {
      alert(e instanceof ApiError ? `保存失败：${e.message}` : '保存失败');
      setTransfers(prev);
    }
  }

  async function persistVisas(next: MockVisaWithStayDays[]) {
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
          // 单次入境最多可停留天数（选填）
          stayDays: n.stayDays ?? undefined,
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
            stayDays: n.stayDays ?? undefined,
          });
        }
      }
      const fresh = await api.listVisas(false);
      setVisas(activeOnly(fresh.visas).map(visaApiToMock));
    } catch (e) {
      alert(e instanceof ApiError ? `保存失败：${e.message}` : '保存失败');
      setVisas(prev);
    }
  }

  async function persistBundles(next: MockBundleWithServiceNotes[]) {
    const prev = bundles;
    setBundles(next);
    try {
      for (const old of prev) if (!next.find((n) => n.id === old.id)) await api.deleteBundle(tk, old.id);
      for (const n of next) if (!prev.find((p) => p.id === n.id)) {
        await api.createBundle(tk, {
          name: n.name, tagline: n.tagline, emoji: n.emoji,
          // 服务内容（选填；每行一条，订单详情行程单据此渲染「服务内容」板块）
          serviceNotes: n.serviceNotes || undefined,
          items: n.items, flightPax: n.flightPax,
          discountPct: n.discountPct ?? 0, groundDiscount: n.groundDiscount, suitableFor: n.suitableFor,
          hotelRoomTypeId: n.hotelRoomTypeId ?? null,
          hotelNights: persistedHotelNights(n),
          singleSupplementCnyPerNight: n.singleSupplementCnyPerNight ?? null,
          businessUpgradeCnyPerLeg: n.businessUpgradeCnyPerLeg ?? null,
          childSeatDiscountCnyPerPerson: n.childSeatDiscountCnyPerPerson ?? null,
          selfVisaDeductCny: n.selfVisaDeductCny ?? null,
          infantPriceCny: n.infantPriceCny ?? null,
          legs: n.legs ?? 2,
          blackoutDates: n.blackoutDates ?? [],
          defaultDepartDate: n.defaultDepartDate ?? null,
          // 绑定航班号（去程/回程）：选了 = flight.id；不指定 = null。
          outboundFlightId: n.outboundFlight?.id ?? null,
          returnFlightId: n.returnFlight?.id ?? null,
        });
      }
      for (const n of next) {
        const old = prev.find((p) => p.id === n.id);
        if (old && JSON.stringify(old) !== JSON.stringify(n)) {
          await api.updateBundle(tk, n.id, {
            name: n.name, tagline: n.tagline, emoji: n.emoji,
            serviceNotes: n.serviceNotes || undefined,
            items: n.items, flightPax: n.flightPax ?? 1,
            // 改价的唯一真源：编辑向导算出新折扣% 后写在 discountPct 上，更新时必须一并回传，
            // 否则后端保留旧折扣 → PATCH 返回 200 但价格没变（"改价保存不了"）。
            discountPct: n.discountPct ?? 0,
            groundDiscount: n.groundDiscount ?? 0, suitableFor: n.suitableFor,
            hotelRoomTypeId: n.hotelRoomTypeId ?? null,
            hotelNights: persistedHotelNights(n),
            singleSupplementCnyPerNight: n.singleSupplementCnyPerNight ?? null,
            businessUpgradeCnyPerLeg: n.businessUpgradeCnyPerLeg ?? null,
            childSeatDiscountCnyPerPerson: n.childSeatDiscountCnyPerPerson ?? null,
            selfVisaDeductCny: n.selfVisaDeductCny ?? null,
            infantPriceCny: n.infantPriceCny ?? null,
            legs: n.legs ?? 2,
            blackoutDates: n.blackoutDates ?? [],
            defaultDepartDate: n.defaultDepartDate ?? null,
            // 绑定航班号（去程/回程）：选了 = flight.id；不指定 = null（解绑）。
            outboundFlightId: n.outboundFlight?.id ?? null,
            returnFlightId: n.returnFlight?.id ?? null,
            isActive: n.active,
          });
        }
      }
      const fresh = await api.listBundles(false);
      setBundles(activeOnly(fresh.bundles).map(bundleApiToMock));
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
        <BundlesSection
          items={bundles}
          roomTypeOptions={roomTypeOptions}
          flightOptions={flightOptions}
          transfers={transfers}
          visas={visas}
          onChange={persistBundles}
        />
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
        // key=编辑目标 id：强制每次「编辑」都重挂载表单，用最新 hotel 重新播种内部 state。
        // 缺 key 时表单实例被复用，新建酒店后刷新列表（id 变、对象换新）会让二次编辑打不开/带旧数据。
        <EditHotelForm
          key={editing.id}
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
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<MockTransfer | null>(null);
  return (
    <div className="space-y-3">
      {editing && (
        // key=编辑目标 id：强制每次「编辑」都重挂载表单，用最新对象重新播种内部 state。
        // 缺 key 时表单实例被复用，新建后刷新列表（id 变、对象换新）会让二次编辑打不开/带旧数据。
        <EditTransferForm
          key={editing.id}
          transfer={editing}
          onCancel={() => setEditing(null)}
          onSave={(t) => { onChange(items.map((x) => x.id === t.id ? t : x)); setEditing(null); }}
        />
      )}
      {showForm && (
        <NewTransferForm
          onCancel={() => setShowForm(false)}
          onSubmit={(t) => { onChange([t, ...items]); setShowForm(false); }}
        />
      )}
      <ActionBar active={items.length} onAdd={() => setShowForm(true)} addLabel="+ 新增车型" />
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
function VisasSection({ items, onChange }: { items: MockVisaWithStayDays[]; onChange: (v: MockVisaWithStayDays[]) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<MockVisaWithStayDays | null>(null);
  return (
    <div className="space-y-3">
      {editing && (
        // key=编辑目标 id：强制每次「编辑」都重挂载表单，用最新对象重新播种内部 state。
        // 缺 key 时表单实例被复用，新建后刷新列表（id 变、对象换新）会让二次编辑打不开/带旧数据。
        <EditVisaForm
          key={editing.id}
          visa={editing}
          onCancel={() => setEditing(null)}
          onSave={(v) => { onChange(items.map((x) => x.id === v.id ? v : x)); setEditing(null); }}
        />
      )}
      {showForm && (
        <NewVisaForm
          onCancel={() => setShowForm(false)}
          onSubmit={(v) => { onChange([v, ...items]); setShowForm(false); }}
        />
      )}
      <ActionBar active={items.length} onAdd={() => setShowForm(true)} addLabel="+ 新增签证产品" />
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
  flightOptions,
  transfers,
  visas,
  onChange,
}: {
  items: MockBundleWithServiceNotes[];
  roomTypeOptions: RoomTypeOption[];
  flightOptions: FlightOption[];
  /** 接送产品下拉选项（在售）；套餐 TRANSFER 组件只能挑产品，不再手填价 */
  transfers: MockTransfer[];
  /** 签证产品下拉选项（在售）；套餐 VISA 组件只能挑产品，不再手填价 */
  visas: MockVisaWithStayDays[];
  onChange: (v: MockBundleWithServiceNotes[]) => void;
}) {
  const [showWizard, setShowWizard] = useState(false);
  const [editing, setEditing] = useState<MockBundleWithServiceNotes | null>(null);
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
          flightOptions={flightOptions}
          transfers={transfers}
          visas={visas}
          flightRefRoundTripCny={deriveFlightRefRoundTrip(items)}
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
          flightOptions={flightOptions}
          transfers={transfers}
          visas={visas}
          initial={editing}
          flightRefRoundTripCny={deriveFlightRefRoundTrip(items)}
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
  // 机票口径：来回 = 去程(单程) + 回程(单程)；拆开显示，避免把来回价误当单程。
  const flight = bundleFlightRoundTrip(bundle);
  // 防御：items 非数组等畸形形状（历史脏数据）时安全兜底为 []，不让一条坏数据挂掉整卡渲染。
  const safeBundleItems = Array.isArray(bundle.items) ? bundle.items : [];
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
        {safeBundleItems.map((i, idx) => (
          <div key={idx} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`rounded-md px-1.5 py-0.5 font-medium ${KIND_LABEL[i.kind].color}`}>
                {KIND_LABEL[i.kind].label}
              </span>
              <span className="text-ink-soft truncate">{i.productName}</span>
            </div>
            {i.kind === 'FLIGHT' ? (
              // 机票不在套餐里逐项定价（随出发日实时浮动，已含在原价）→ 标「往返」而非 ¥0。
              <span className="text-ink-muted whitespace-nowrap">往返（去+回两程）</span>
            ) : (
              <span className="text-ink-muted nums whitespace-nowrap">
                {i.kind === 'HOTEL'
                  ? `${i.qty} 晚 × ¥${i.unitPrice}/晚 = ¥`
                  : `${i.qty} × ¥${i.unitPrice} = ¥`}
                {(i.qty * i.unitPrice).toLocaleString()}
              </span>
            )}
          </div>
        ))}
      </div>

      {flight && (
        // 机票往返口径拆开：去程(单程) + 回程(单程) = 来回×1，避免运营把来回价误当单程。
        <div className="mt-2 rounded-lg border border-sky-100 bg-sky-50/60 px-3 py-2 text-xs">
          <div className="flex items-center justify-between text-sky-800">
            <span className="font-medium">✈️ 机票 往返 / 人</span>
            <span className="nums font-semibold">¥{flight.roundTrip.toLocaleString()}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-sky-700/90">
            <span className="nums">去程 ¥{flight.outbound.toLocaleString()} + 回程 ¥{flight.inbound.toLocaleString()}</span>
            <span className="text-[11px] text-sky-700/70">共 2 程 · 按当前最低起价</span>
          </div>
        </div>
      )}

      {bundle.hotelRoomType && (
        <div className="mt-2 text-xs text-ink-soft">
          🏨 关联酒店：{bundle.hotelRoomType.hotelName} · {bundle.hotelRoomType.name}
          {bundle.hotelNights ? `（${bundle.hotelNights} 晚）` : ''}
        </div>
      )}

      {(bundle.outboundFlight || bundle.returnFlight) && (
        <div className="mt-1 text-xs text-ink-soft">
          ✈️
          {bundle.outboundFlight && <> 去程 {flightRefLabel(bundle.outboundFlight)}</>}
          {bundle.outboundFlight && bundle.returnFlight && ' · '}
          {bundle.returnFlight && <> 回程 {flightRefLabel(bundle.returnFlight)}</>}
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

      {(bundle.childSeatDiscountCnyPerPerson != null || bundle.infantPriceCny != null || (bundle.selfVisaDeductCny != null && bundle.selfVisaDeductCny > 0)) && (
        <div className="mt-1 text-xs text-ink-soft">
          {bundle.childSeatDiscountCnyPerPerson != null && (
            <>🧒 占座儿童差价 −¥{bundle.childSeatDiscountCnyPerPerson.toLocaleString()}/人</>
          )}
          {bundle.childSeatDiscountCnyPerPerson != null && bundle.infantPriceCny != null && ' · '}
          {bundle.infantPriceCny != null && (
            <>👶 婴儿价 ¥{bundle.infantPriceCny.toLocaleString()}/人</>
          )}
          {(bundle.childSeatDiscountCnyPerPerson != null || bundle.infantPriceCny != null) && bundle.selfVisaDeductCny != null && bundle.selfVisaDeductCny > 0 && ' · '}
          {bundle.selfVisaDeductCny != null && bundle.selfVisaDeductCny > 0 && (
            <>🛂 自备签证 −¥{bundle.selfVisaDeductCny.toLocaleString()}/单</>
          )}
        </div>
      )}

      <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50/60 p-3">
        <div className="flex items-end justify-between">
          <span className="text-sm text-ink-soft">
            起价 / 人<span className="ml-1 text-xs text-ink-muted">(from · 拼房)</span>
          </span>
          <span className="text-2xl font-semibold text-brand-700 nums">
            from ¥{(bundle.originalPerPaxCny ?? 0).toLocaleString()}
          </span>
        </div>
        <p className="mt-1 text-right text-[11px] text-ink-muted">
          双人拼房价 · 单人独住+单房差 · 实际按出发日实时机票浮动
        </p>
      </div>

      <div className="mt-2 rounded-lg border border-slate-100 bg-canvas p-3">
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
        <p className="mt-1 text-right text-[11px] text-ink-muted">原价含当前最低机票 · 实际按出发日实时机票浮动</p>
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
  flightOptions,
  transfers,
  visas,
  initial,
  flightRefRoundTripCny,
  onCancel,
  onSubmit,
}: {
  roomTypeOptions: RoomTypeOption[];
  /** 可绑定的航班号选项（去程/回程下拉）；value = flight.id */
  flightOptions: FlightOption[];
  /** 接送产品下拉选项（在售）；TRANSFER 组件只能挑产品，价格只读来自产品 */
  transfers: MockTransfer[];
  /** 签证产品下拉选项（在售）；VISA 组件只能挑产品，价格只读来自产品 */
  visas: MockVisaWithStayDays[];
  /** 传入既有套餐 = 编辑模式（各字段预填）；缺省 = 新建 */
  initial?: MockBundleWithServiceNotes;
  /** 当前最低来回机票 / 人（CNY）：起价 / 人公式里的机票项；页面从已有套餐推得 */
  flightRefRoundTripCny?: number | null;
  onCancel: () => void;
  onSubmit: (b: MockBundleWithServiceNotes) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [tagline, setTagline] = useState(initial?.tagline ?? '');
  // 服务内容（订单详情行程单「服务内容」板块用；每行一条，选填）
  const [serviceNotes, setServiceNotes] = useState(initial?.serviceNotes ?? '');
  const [emoji, setEmoji] = useState(initial?.emoji ?? '🎁');
  const [suitableFor, setSuitableFor] = useState(initial?.suitableFor ?? '2 大人');
  const [hotelRoomTypeId, setHotelRoomTypeId] = useState(initial?.hotelRoomTypeId ?? '');
  // 住宿晚数 = 唯一真源：同时驱动 hotelNights + 首个 HOTEL 项的 qty。
  // 预填：旧数据 hotelNights 可能为 null，回退到 HOTEL 项 qty，再回退 1。
  const initialFirstHotelQty = initial?.items.find((it) => it.kind === 'HOTEL')?.qty ?? null;
  const initialNights = initial ? initial.hotelNights ?? initialFirstHotelQty ?? 1 : 3;
  const [hotelNights, setHotelNights] = useState<number | null>(initialNights);
  // 不可售日期（blackout，按出发日，单套餐粒度）+ 前台默认出发日
  const [blackoutDates, setBlackoutDates] = useState<BlackoutDateRow[]>(initial?.blackoutDates ?? []);
  const [defaultDepartDate, setDefaultDepartDate] = useState<string>(initial?.defaultDepartDate ?? '');
  // 绑定航班号（去程/回程）：存 flight.id，空串 = 不指定（按最便宜航班）。编辑时从已绑航班预填。
  const [outboundFlightId, setOutboundFlightId] = useState<string>(initial?.outboundFlight?.id ?? '');
  const [returnFlightId, setReturnFlightId] = useState<string>(initial?.returnFlight?.id ?? '');
  // 自愿升级展示价（CNY；留空 = 前台不展示该升级项）
  const [singleSupplement, setSingleSupplement] = useState<number | null>(initial?.singleSupplementCnyPerNight ?? null);
  const [businessUpgrade, setBusinessUpgrade] = useState<number | null>(initial?.businessUpgradeCnyPerLeg ?? null);
  // 大人/小孩区分（CNY；留空 = 用服务端默认：占座儿童差价 ¥30、婴儿价 ¥0）
  const [childSeatDiscount, setChildSeatDiscount] = useState<number | null>(initial?.childSeatDiscountCnyPerPerson ?? null);
  const [selfVisaDeduct, setSelfVisaDeduct] = useState<number | null>(initial?.selfVisaDeductCny ?? null);
  const [infantPrice, setInfantPrice] = useState<number | null>(initial?.infantPriceCny ?? null);
  const [legs, setLegs] = useState<number | null>(initial?.legs ?? 2);
  // Local draft shape allowing null for in-progress numeric edits.
  // transferId/visaId：TRANSFER/VISA 组件挑的产品 id（价格只读，来自产品，见 productPriceFor）。
  type DraftBundleItem = Omit<BundleItem, 'qty' | 'unitPrice'> & {
    qty: number | null;
    unitPrice: number | null;
    transferId?: string | null;
    visaId?: string | null;
  };
  const [items, setItems] = useState<DraftBundleItem[]>(() => {
    if (initial && initial.items.length > 0) {
      const firstHotel = initial.items.findIndex((it) => it.kind === 'HOTEL');
      // 首个 HOTEL 项数量归一到住宿晚数（修旧数据 qty 与 hotelNights 分叉）。
      return initial.items.map((it, i) => {
        const raw = it as BundleItem & { transferId?: string | null; visaId?: string | null };
        return {
          kind: it.kind,
          productName: it.productName,
          qty: i === firstHotel ? initialNights : it.qty,
          unitPrice: it.unitPrice,
          transferId: raw.transferId ?? null,
          visaId: raw.visaId ?? null,
        };
      });
    }
    return [{ kind: 'HOTEL', productName: '岘港凯悦度假村', qty: 3, unitPrice: 1880 }];
  });
  // 房型整间夜价（¥/晚，只读展示 + 起价公式用）：未关联房型 → 0。
  const selectedRoomType = roomTypeOptions.find((o) => o.id === hotelRoomTypeId) ?? null;
  const hotelNightlyPriceCny = selectedRoomType?.nightlyPriceCny ?? 0;
  // 接送 / 签证组件价格权威来源 = 所挑产品的 basePrice（只读，运营不可手改）。
  const transferPriceById = useMemo(() => new Map(transfers.map((t) => [t.id, t.basePrice])), [transfers]);
  const visaPriceById = useMemo(() => new Map(visas.map((v) => [v.id, v.basePrice])), [visas]);
  // 地面合计（参考展示用，1 间房口径）：只算非机票行，价格取权威产品价（HOTEL 用整间夜价 × 晚数）。
  const listPrice = useMemo(
    () =>
      items.reduce((s, i) => {
        if (i.kind === 'FLIGHT') return s;
        if (i.kind === 'HOTEL') return s + hotelNightlyPriceCny * (i.qty ?? 0);
        if (i.kind === 'TRANSFER') return s + (i.transferId ? (transferPriceById.get(i.transferId) ?? 0) : 0) * (i.qty ?? 0);
        return s + (i.visaId ? (visaPriceById.get(i.visaId) ?? 0) : 0) * (i.qty ?? 0);
      }, 0),
    [items, hotelNightlyPriceCny, transferPriceById, visaPriceById],
  );
  // 住宿晚数是否可填 = 套餐里是否含 HOTEL 项（不再仅靠是否关联房型）。
  const hasHotelItem = items.some((it) => it.kind === 'HOTEL');
  const firstHotelIdx = items.findIndex((it) => it.kind === 'HOTEL');
  // 起价 / 人（唯一权威口径，1 人·半间房拼房）—— 与后端 computeBundleOriginalPerPaxCny 公式一致：
  //   flightRoundTripPerPax + 0.5×房型整间夜价×晚数 + 接送合计(Σqty×单价) + 签证/人(ΣunitPrice，忽略 qty)。
  // 0.5 已在这里生效，酒店组件行本身仍展示整间价，不要重复打折。
  const nightsForPricing = hasHotelItem ? hotelNights ?? 0 : 0;
  const transferTotal = useMemo(
    () =>
      items
        .filter((i) => i.kind === 'TRANSFER')
        .reduce((s, i) => s + (i.qty ?? 0) * (i.transferId ? (transferPriceById.get(i.transferId) ?? 0) : 0), 0),
    [items, transferPriceById],
  );
  const visaPerPax = useMemo(
    () =>
      items
        .filter((i) => i.kind === 'VISA')
        .reduce((s, i) => s + (i.visaId ? (visaPriceById.get(i.visaId) ?? 0) : 0), 0),
    [items, visaPriceById],
  );
  const originalPerPax = Math.round(
    (flightRefRoundTripCny ?? 0) + 0.5 * hotelNightlyPriceCny * nightsForPricing + transferTotal + visaPerPax,
  );
  // 运营录入「想卖的价格 / 人」(目标起价，基于 originalPerPaxCny)；系统反推折扣%。
  // 初值 = 现折后价/人(编辑，优先用服务端权威 originalPerPaxCny) 或 原价/人(新建·0折)。
  const [targetPerPax, setTargetPerPax] = useState<number | null>(
    initial != null
      ? Math.round((initial.originalPerPaxCny ?? originalPerPax) * (1 - (initial.discountPct ?? 0) / 100))
      : null,
  );
  // 反推折扣%（夹 0..100）：起价/人为 0 或目标价空 → 0 折。套餐价 = 整个全包价 ×(1 − pct/100)。
  const pct =
    originalPerPax > 0 && targetPerPax != null
      ? Math.min(100, Math.max(0, Math.round((1 - targetPerPax / originalPerPax) * 100)))
      : 0;
  const bundlePrice = Math.round(listPrice * (1 - pct / 100)); // 地面折后（参考）
  // 名称里若写了「N 晚」，与当前晚数不一致 → 软提示（不阻断提交）。
  const nameNightsMatch = name.match(/(\d+)\s*晚/);
  const nameNights = nameNightsMatch ? Number(nameNightsMatch[1]) : null;
  const nightsHint = hasHotelItem && nameNights != null && hotelNights != null && nameNights !== hotelNights;
  // 关联房型时晚数必须 1–30；含 HOTEL 项时晚数须为正整数。
  const nightsValid = !hasHotelItem || (hotelNights != null && hotelNights >= 1 && hotelNights <= 30);
  const hotelLinkValid = !hotelRoomTypeId || (hotelNights != null && hotelNights >= 1 && hotelNights <= 30);
  // TRANSFER/VISA 组件必须选了产品才能定价（与后端「必须关联接送/签证产品」校验一致，提交前先在前端拦一遍）。
  const allComponentsLinked = items.every((it) => {
    if (it.kind === 'TRANSFER') return !!it.transferId;
    if (it.kind === 'VISA') return !!it.visaId;
    return true;
  });
  const valid =
    name.length > 0 && items.length > 0 && bundlePrice > 0 && hotelLinkValid && nightsValid && allComponentsLinked;

  // 住宿晚数 = 唯一真源：写入 hotelNights 的同时镜像给首个 HOTEL 项的 qty。
  const setNights = (n: number | null) => {
    setHotelNights(n);
    if (n != null && firstHotelIdx >= 0) {
      setItems((prev) =>
        prev.map((it, i) => (i === firstHotelIdx ? { ...it, qty: n } : it)),
      );
    }
  };

  // 新增组件：价格只读来自产品，新增行不预填价（TRANSFER/VISA 须选产品才有价，见下方下拉）。
  const addItem = (kind: BundleItem['kind']) => {
    const presets: Record<BundleItem['kind'], DraftBundleItem> = {
      FLIGHT: { kind: 'FLIGHT', productName: '澳门⇌岘港 经济舱', qty: 2, unitPrice: 0 },
      HOTEL: { kind: 'HOTEL', productName: '岘港凯悦度假村', qty: hotelNights ?? 1, unitPrice: 0 },
      TRANSFER: { kind: 'TRANSFER', productName: '', qty: 2, unitPrice: 0, transferId: null },
      VISA: { kind: 'VISA', productName: '', qty: 2, unitPrice: 0, visaId: null },
    };
    setItems([...items, presets[kind]]);
  };

  // 去程/回程方向过滤：单一往返航线，回程须从去程到达地起飞（origin = 去程 destination）。
  // 反向亦然。不硬编码机场码，全靠所选航班的 origin/destination 推导。
  const outboundSel = flightOptions.find((o) => o.id === outboundFlightId) ?? null;
  const returnSel = flightOptions.find((o) => o.id === returnFlightId) ?? null;
  // 回程候选：选了去程 → 只留「从去程到达地起飞」的航班；未选 → 全部。
  // 兜底：始终保留当前已绑回程（编辑预填时方向过滤不该把已绑值挤掉）。
  const returnOptions = useMemo(() => {
    if (!outboundSel) return flightOptions;
    return flightOptions.filter(
      (o) => o.originCode === outboundSel.destinationCode || o.id === returnFlightId,
    );
  }, [flightOptions, outboundSel, returnFlightId]);
  // 去程候选：对称过滤 —— 选了回程 → 只留「到达地 = 回程出发地」的航班；未选 → 全部。始终保留已绑去程。
  const outboundOptions = useMemo(() => {
    if (!returnSel) return flightOptions;
    return flightOptions.filter(
      (o) => o.destinationCode === returnSel.originCode || o.id === outboundFlightId,
    );
  }, [flightOptions, returnSel, outboundFlightId]);

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
            <label className="label">服务内容（选填，每行一条，订单详情行程单据此展示）</label>
            <textarea
              className="input min-h-[88px]"
              value={serviceNotes}
              onChange={(e) => setServiceNotes(e.target.value)}
              placeholder={'中文客服，越南当地机场助签\n举牌接机，送至酒店并协助分房\n离境日通知旅客，送往机场并辅助值机'}
            />
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
              <p className="mt-1 text-xs text-ink-soft">
                💡 关联后：房控库存会联动套餐可售日期；选的人数超过房型容量时自动加房收费。<span className="font-medium">不关联 = 酒店不参与库存/日期校验</span>。
              </p>
              {!hotelRoomTypeId && roomTypeOptions.length > 0 && (
                <p className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  ⚠️ 未关联酒店：该套餐不做房量/日期校验。建议从上方下拉选一个房型；确需纯机票/无房套餐可保留"不关联"。
                </p>
              )}
              <p className="mt-1 text-xs text-ink-muted">找不到酒店？在 产品管理 › 酒店 里添加/编辑（含介绍、图片、房型）。</p>
            </div>
            {hasHotelItem && (
              <div>
                <label className="label">住宿晚数 *</label>
                <NumberInput min={1} max={30} className="input" value={hotelNights} onChange={setNights} integerOnly />
                <p className="mt-1 text-xs text-ink-muted">同步酒店项数量；房控按此计入占房。</p>
                {nightsHint && (
                  <p className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                    ⚠️ 套餐名里写的「{nameNights} 晚」与住宿晚数（{hotelNights} 晚）不一致，请确认。
                  </p>
                )}
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

          {/* 绑定航班号（去程/回程）：只绑航班号，不绑某一天班次；买家选出发日后系统匹配当天班次 */}
          <div>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="label">去程航班</label>
                <select
                  className="input"
                  value={outboundFlightId}
                  onChange={(e) => setOutboundFlightId(e.target.value)}
                >
                  <option value="">不指定（按最便宜航班）</option>
                  {outboundOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">回程航班</label>
                <select
                  className="input"
                  value={returnFlightId}
                  onChange={(e) => setReturnFlightId(e.target.value)}
                >
                  <option value="">不指定（按最便宜航班）</option>
                  {returnOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              绑定航班号即可（不用选某一天）。买家选出发日后，系统按航班号自动匹配当天班次。
            </p>
            {flightOptions.length === 0 && (
              <p className="mt-1 text-xs text-ink-muted">暂无可选航班？在 航班管理 里添加航班后即可绑定。</p>
            )}
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
            <div>
              <label className="label">自备签证可减额（¥/单，每张套餐减一次）</label>
              <NumberInput
                min={0}
                max={1000000}
                className="input"
                placeholder="留空 = 0（不减）"
                value={selfVisaDeduct}
                onChange={(n) => setSelfVisaDeduct(n)}
                integerOnly
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="label !mb-0">套餐内容</label>
              <div className="flex gap-2">
                {(['FLIGHT', 'HOTEL', 'TRANSFER', 'VISA'] as const).map((k) => (
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
              {items.map((it, idx) => {
                // 组件价格只读、来自产品：TRANSFER/VISA 挑产品定价，HOTEL 用房型整间夜价，FLIGHT 恒自动。
                const unitPriceReadOnly =
                  it.kind === 'HOTEL'
                    ? hotelNightlyPriceCny
                    : it.kind === 'TRANSFER'
                      ? (it.transferId ? transferPriceById.get(it.transferId) : undefined) ?? 0
                      : it.kind === 'VISA'
                        ? (it.visaId ? visaPriceById.get(it.visaId) : undefined) ?? 0
                        : 0;
                return (
                  <div key={idx} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-canvas p-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_LABEL[it.kind].color}`}>
                      {KIND_LABEL[it.kind].label}
                    </span>
                    {it.kind === 'TRANSFER' ? (
                      // 接送产品下拉：价格只读来自产品，不再手填（换产品自动重新取价）。
                      <select
                        className="input flex-1 text-xs"
                        value={it.transferId ?? ''}
                        onChange={(e) => {
                          const t = transfers.find((x) => x.id === e.target.value) ?? null;
                          const next = [...items];
                          next[idx] = { ...it, transferId: t?.id ?? null, productName: t?.name ?? '' };
                          setItems(next);
                        }}
                      >
                        <option value="">选择接送产品…</option>
                        {transfers.map((t) => (
                          <option key={t.id} value={t.id}>{t.name} · ¥{t.basePrice}</option>
                        ))}
                      </select>
                    ) : it.kind === 'VISA' ? (
                      // 签证产品下拉：价格只读来自产品，不再手填（换产品自动重新取价）。
                      <select
                        className="input flex-1 text-xs"
                        value={it.visaId ?? ''}
                        onChange={(e) => {
                          const v = visas.find((x) => x.id === e.target.value) ?? null;
                          const next = [...items];
                          next[idx] = { ...it, visaId: v?.id ?? null, productName: v ? `${v.country} · ${v.type}` : '' };
                          setItems(next);
                        }}
                      >
                        <option value="">选择签证产品…</option>
                        {visas.map((v) => (
                          <option key={v.id} value={v.id}>{v.country} · {v.type} · ¥{v.basePrice}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="input flex-1 text-xs"
                        value={it.productName}
                        onChange={(e) => {
                          const next = [...items];
                          next[idx] = { ...it, productName: e.target.value };
                          setItems(next);
                        }}
                        placeholder={it.kind === 'HOTEL' ? '房型/描述（价格由上方关联房型决定）' : undefined}
                      />
                    )}
                    {it.kind === 'HOTEL' && idx === firstHotelIdx ? (
                      // 首个 HOTEL 项数量 = 住宿晚数派生值，只读，避免第二真源。
                      <NumberInput
                        min={1}
                        className="input w-16 text-xs bg-canvas text-ink-muted"
                        value={hotelNights}
                        onChange={() => {}}
                        disabled
                        integerOnly
                      />
                    ) : (
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
                    )}
                    {it.kind === 'FLIGHT' ? (
                      // 机票不在套餐里填价：按航班最便宜那天做起价（自动，含在起价里），下单按出发日实时浮动。
                      <div className="flex w-24 flex-col items-end justify-center text-right">
                        <span className="text-xs text-ink-muted">按航班</span>
                        <span className="text-[10px] leading-tight text-ink-muted">最便宜起价·自动</span>
                      </div>
                    ) : (
                      // 只读价格：来自产品（HOTEL=整间夜价 / TRANSFER=接送产品价 / VISA=签证产品价），运营不可手改。
                      <span className="input flex w-24 items-center justify-end bg-canvas text-xs text-ink-muted nums">
                        ¥{unitPriceReadOnly.toLocaleString()}
                      </span>
                    )}
                    <span className="text-xs text-ink-muted w-20 text-right nums">
                      {it.kind === 'FLIGHT' ? '实时' : `¥${((it.qty ?? 0) * unitPriceReadOnly).toLocaleString()}`}
                    </span>
                    <button
                      type="button"
                      className="text-xs text-ink-muted hover:text-rose-600"
                      onClick={() => setItems(items.filter((_, i) => i !== idx))}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
              💡 组件价格只读、来自产品：酒店取上方关联房型的整间夜价（数量=住宿晚数）；接送/签证挑产品后自动取价，换产品自动重新取价。
            </p>
            {transfers.length === 0 && items.some((it) => it.kind === 'TRANSFER') && (
              <p className="mt-1 text-xs text-amber-700">⚠️ 暂无在售接送产品，请先到 产品管理 › 地面服务 里添加。</p>
            )}
            {visas.length === 0 && items.some((it) => it.kind === 'VISA') && (
              <p className="mt-1 text-xs text-amber-700">⚠️ 暂无在售签证产品，请先到 产品管理 › 签证 里添加。</p>
            )}
          </div>

          <div className="rounded-lg border border-slate-100 bg-canvas p-3 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-soft">
                起价 / 人<span className="ml-1 text-xs text-ink-muted">(from，1 人·半间房拼房口径)</span>
              </span>
              <span className="font-medium text-ink nums">¥{originalPerPax.toLocaleString()}</span>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-muted">
              双人拼房价 · 单人独住 +单房差 · 实际按出发日实时机票浮动
            </p>
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-soft">
                想卖的价格 / 人
                <span className="ml-1 text-xs text-ink-muted">(目标起价)</span>
              </span>
              <div className="flex items-center gap-1">
                <span className="text-ink-muted">¥</span>
                <NumberInput
                  min={0}
                  className="input w-28 text-right"
                  value={targetPerPax}
                  onChange={(n) => setTargetPerPax(n)}
                />
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 pt-2">
              <span className="text-sm text-ink-soft">折扣<span className="ml-1 text-xs text-ink-muted">(也可直接改)</span></span>
              <div className="flex items-center gap-1">
                <NumberInput
                  min={0}
                  max={100}
                  className="input w-20 text-right text-lg font-semibold"
                  value={pct}
                  onChange={(n) => {
                    const p = Math.min(100, Math.max(0, n ?? 0));
                    // 直接改折扣% → 反算想卖的价（两个字段联动，单一真源仍是 targetPerPax）
                    setTargetPerPax(originalPerPax > 0 ? Math.round(originalPerPax * (1 - p / 100)) : null);
                  }}
                  integerOnly
                />
                <span className="text-ink-muted">%</span>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-muted">
              💡 机票按<strong>航班最便宜那天</strong>做起价（已含在"起价"里，你不用在套餐里填机票价）；酒店按<strong>关联房型整间夜价的一半</strong>（拼房）计入起价。你填
              <strong>想卖的价格</strong>、或直接改<strong>折扣%</strong>都行，两个会自动联动。实际下单：整个全包价按
              <strong>出发日实时机票</strong>浮动 ×(1−{pct}%)，前台买家看到「起价 from ¥X/人 → 省 {pct}%」。
            </p>
            {pct > 0 && (
              <div className="text-right text-xs text-emerald-700">
                整个全包价省 {pct}%
              </div>
            )}
            {!valid && (
              <p className="text-xs text-rose-600">⚠️ 请填写套餐名 + 至少 1 个产品 + 套餐价 &gt; 0 + 接送/签证组件都已选产品</p>
            )}
            {!nightsValid && (
              <p className="text-xs text-rose-600">⚠️ 含酒店项时，住宿晚数需为 1–30 的整数</p>
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
                  serviceNotes: serviceNotes || undefined,
                  emoji,
                  items: items.map((it) => {
                    // 组件价格只读、来自产品：服务端会按 transferId/visaId/关联房型权威重算 unitPrice，
                    // 这里传的值仅作占位通过 schema 校验（真正生效的是 transferId/visaId + hotelRoomTypeId）。
                    const unitPrice =
                      it.kind === 'FLIGHT'
                        ? 0
                        : it.kind === 'HOTEL'
                          ? hotelNightlyPriceCny
                          : it.kind === 'TRANSFER'
                            ? (it.transferId ? transferPriceById.get(it.transferId) : undefined) ?? 0
                            : (it.visaId ? visaPriceById.get(it.visaId) : undefined) ?? 0;
                    return {
                      kind: it.kind,
                      productName: it.productName,
                      qty: Math.max(1, it.qty ?? 1),
                      unitPrice,
                      ...(it.kind === 'TRANSFER' ? { transferId: it.transferId ?? null } : {}),
                      ...(it.kind === 'VISA' ? { visaId: it.visaId ?? null } : {}),
                    };
                  }),
                  listPrice,
                  bundlePrice,
                  discountPct: pct,
                  groundDiscount: 0,
                  flightPax: 2,
                  suitableFor,
                  active: initial?.active ?? true,
                  hotelRoomTypeId: hotelRoomTypeId || null,
                  // 住宿晚数唯一真源：含 HOTEL 项即提交晚数（与首个 HOTEL 项 qty 一致），与是否关联房型无关。
                  hotelNights: hasHotelItem ? hotelNights ?? 1 : null,
                  singleSupplementCnyPerNight: singleSupplement,
                  businessUpgradeCnyPerLeg: businessUpgrade,
                  childSeatDiscountCnyPerPerson: childSeatDiscount,
                  selfVisaDeductCny: selfVisaDeduct,
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
                  // 绑定航班号（去程/回程）：回建引用；不选 = null（不指定，按最便宜航班）
                  outboundFlight: resolveFlightRef(outboundFlightId, flightOptions, initial?.outboundFlight),
                  returnFlight: resolveFlightRef(returnFlightId, flightOptions, initial?.returnFlight),
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

/** 新增地面服务：复用统一编辑器，预填一份合理空白模板（弹窗内填好再 POST）。 */
function NewTransferForm({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (t: MockTransfer) => void }) {
  const blank: MockTransfer = {
    id: 't-' + Date.now(),
    name: '',
    vehicleType: '舒适型轿车',
    capacity: 3,
    basePrice: 128,
    originArea: '岘港机场 (DAD)',
    destArea: '美溪海滩',
    emoji: '🚗',
    photo: '',
    features: ['含中文司机'],
    duration: '约 15 分钟',
  };
  return (
    <TransferEditorForm transfer={blank} title="新增地面服务" submitLabel="添加" onCancel={onCancel} onSave={onSubmit} />
  );
}

function EditTransferForm({ transfer, onCancel, onSave }: { transfer: MockTransfer; onCancel: () => void; onSave: (t: MockTransfer) => void }) {
  return (
    <TransferEditorForm
      transfer={transfer}
      title={`编辑地面服务 · ${transfer.name}`}
      submitLabel="保存修改"
      onCancel={onCancel}
      onSave={onSave}
    />
  );
}

function TransferEditorForm({
  transfer,
  title,
  submitLabel,
  onCancel,
  onSave,
}: {
  transfer: MockTransfer;
  title: string;
  submitLabel: string;
  onCancel: () => void;
  onSave: (t: MockTransfer) => void;
}) {
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
        <h3 className="font-semibold text-ink">{title}</h3>
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
          <button type="submit" className="btn-primary">{submitLabel}</button>
        </div>
      </form>
    </section>
  );
}

/** 新增签证：复用统一编辑器，预填一份合理空白模板（弹窗内填好再 POST）。 */
function NewVisaForm({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (v: MockVisaWithStayDays) => void }) {
  const blank: MockVisaWithStayDays = {
    id: 'v-' + Date.now(),
    country: '',
    countryCode: 'XX',
    flag: '🌍',
    type: '旅游签',
    processingDays: 7,
    basePrice: 380,
    expressSurcharge: 150,
    requiredDocs: ['护照', '照片'],
    validityMonths: 3,
  };
  return (
    <VisaEditorForm visa={blank} title="新增签证" submitLabel="添加" onCancel={onCancel} onSave={onSubmit} />
  );
}

function EditVisaForm({ visa, onCancel, onSave }: { visa: MockVisaWithStayDays; onCancel: () => void; onSave: (v: MockVisaWithStayDays) => void }) {
  return (
    <VisaEditorForm
      visa={visa}
      title={`编辑签证 · ${visa.country} ${visa.type}`}
      submitLabel="保存修改"
      onCancel={onCancel}
      onSave={onSave}
    />
  );
}

function VisaEditorForm({
  visa,
  title,
  submitLabel,
  onCancel,
  onSave,
}: {
  visa: MockVisaWithStayDays;
  title: string;
  submitLabel: string;
  onCancel: () => void;
  onSave: (v: MockVisaWithStayDays) => void;
}) {
  const [form, setForm] = useState({ ...visa, highlight: visa.highlight ?? '' });
  const [basePrice, setBasePrice] = useState<number | null>(visa.basePrice);
  const [expressSurcharge, setExpressSurcharge] = useState<number | null>(visa.expressSurcharge);
  const [processingDays, setProcessingDays] = useState<number | null>(visa.processingDays);
  const [validityMonths, setValidityMonths] = useState<number | null>(visa.validityMonths);
  // 单次入境最多可停留天数（选填；订单详情行程单「最多可停留 X 天」+ 推算生效/失效日期用）
  const [stayDays, setStayDays] = useState<number | null>(visa.stayDays ?? null);
  const [docsText, setDocsText] = useState(visa.requiredDocs.join(', '));
  const [saved, setSaved] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const updated: MockVisaWithStayDays = {
      ...form,
      basePrice: basePrice ?? 0,
      expressSurcharge: expressSurcharge ?? 0,
      processingDays: processingDays ?? 1,
      validityMonths: validityMonths ?? 1,
      highlight: form.highlight || undefined,
      requiredDocs: docsText.split(',').map(s => s.trim()).filter(Boolean),
      stayDays: stayDays ?? undefined,
    };
    setSaved(true);
    setTimeout(() => onSave(updated), 800);
  };

  return (
    <section className="card border-brand-200 bg-brand-50/40">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-ink">{title}</h3>
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
        <div>
          <label className="label text-xs">单次最多停留（天，选填）</label>
          <NumberInput min={1} max={365} className="input" value={stayDays} onChange={(n) => setStayDays(n)} integerOnly placeholder="不限则留空" />
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
          <button type="submit" className="btn-primary">{submitLabel}</button>
        </div>
      </form>
    </section>
  );
}
