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
import { api, ApiError, type Hotel, type Transfer as ApiTransfer, type Visa as ApiVisa, type VisaIssuanceMethod, type VisaEntryType, type VisaExpressTier, type Bundle as ApiBundle, type AdminFlight, type BundleFlightRef, type SettlementTier } from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';
import { BundleBlackoutEditor, type BlackoutDateRow } from '../components/BundleBlackoutEditor';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect';

// 0702 反馈 1：服务内容 / 单次最多停留天数 —— MockVisa/MockBundle（lib/mockData.ts）暂未声明这两个字段，
// 用本页局部扩展类型承接，不改共享 mock 类型定义。0702 反馈 5：签证成本价同一批加进来，与 stayDays 挂同一个扩展类型。
// 签证台批 VD1：签发方式/入境次数结构化分类同一批局部扩展承接（未设置 = null/undefined，表单留空）。
type MockVisaWithStayDays = MockVisa & {
  stayDays?: number | null;
  costPriceCny?: number | null;
  issuanceMethod?: VisaIssuanceMethod | null;
  entryType?: VisaEntryType | null;
  /** 签证公司/代办渠道名（财务对账用——核对某笔签证金额属于哪家供应商的账单）；未录为 null */
  supplier?: string | null;
  /**
   * 加急档位（零工/一工/二工…）：各档自己的出签工作日 + 加价。空数组 = 未配分档，
   * 沿用旧的单值「加急附加费」。录单只选档名，加价金额由服务端按本表算。
   */
  expressTiers?: VisaExpressTier[];
};
type MockBundleWithServiceNotes = MockBundle & {
  serviceNotes?: string | null;
  /** 管理端可编辑排序值：数字小的排前面（列表 + 录单套餐下拉同口径）；留空排最后 */
  sortOrder?: number | null;
  /** 结算价日历取价键：酒店档次 + 住宿晚数（都配了才走日历取价；null = 不走日历） */
  settlementTier?: SettlementTier | null;
  settlementNights?: number | null;
};

/** 加急档位数量上限（与后端 products.schemas VISA_EXPRESS_TIER_MAX 同值）。 */
const VISA_EXPRESS_TIER_MAX = 10;

// 结算价档次中文标签（前端映射；后端只存枚举值）
const SETTLEMENT_TIER_LABELS: Record<SettlementTier, string> = {
  CITY_3STAR: '市区三星',
  CITY_4STAR: '市区四星',
  CITY_5STAR: '市区五星',
  INTL_5STAR: '国际五星',
};
// 0702 反馈 3：起价拆解需要房型整间夜价 —— MockBundle.hotelRoomType（lib/mockData.ts）里没声明
// nightlyPriceCny，但后端 serializeBundle 实际会发（见 products.service.ts BUNDLE_ROOM_INCLUDE /
// serializeBundle），本页局部扩展类型承接，不改共享 mock 类型定义。
type BundleHotelRoomTypeWithPrice = { id: string; name: string; hotelName: string; nightlyPriceCny?: number | null };

// 0702 反馈 5：成本价（仅内部，前台不显示）—— mockData 共享类型（HotelRoomType/MockTransfer）未声明
// costPriceCny，与上面 stayDays 同一手法，局部扩展类型承接，不改共享 mock 类型定义。
type RoomTypeWithCost = HotelRoomType & { costPriceCny?: number | null };
// 0805 A3：国际五星标记 —— mockData 共享类型（MockHotel）未声明 intlFiveStar，
// 与上面 costPriceCny 同一手法，局部扩展类型承接，不改共享 mock 类型定义。
// starRating(stars) 仍是纯 1..5 整数语义；国际五星 = stars=5 且本标记为 true。
type MockHotelWithCost = Omit<MockHotel, 'roomTypes'> & {
  roomTypes: RoomTypeWithCost[];
  intlFiveStar?: boolean;
  // 指定酒店加价（CNY/人）：套餐录单点名住本酒店时按占座人数加收；0 = 指定不加价。
  designationSurchargeCnyPerPerson?: number;
};
type MockTransferWithCost = MockTransfer & { costPriceCny?: number | null };

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
function hotelApiToMock(h: Hotel): MockHotelWithCost {
  return {
    id: h.id,
    code: h.code,
    name: h.name,
    nameEn: h.nameEn ?? h.name,
    cityCode: h.cityCode,
    area: h.area ?? h.address,
    address: h.address ?? '',
    stars: (h.starRating as 3 | 4 | 5) ?? 4,
    intlFiveStar: h.intlFiveStar ?? false,
    designationSurchargeCnyPerPerson: h.designationSurchargeCnyPerPerson ?? 0,
    basePrice: Number(h.basePrice ?? 0),
    // 0702 反馈 2：serializeHotel 现在发 rating:{average,count} 对象，不是旧 Decimal 字符串——
    // Number(对象) = NaN，写回 create/update 会被 JSON 序列化成 null，后端 z.number() 校验直接拒绝
    // （"Expected number, received null"，即"酒店编辑全挂"根因）。这里改读 average，且下面
    // persistHotels 已彻底不再把 rating 回传给后端（表单本就没有编辑评分的入口）。
    rating: h.rating?.average ?? 0,
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
      // 净房价（仅内部）：匿名/未带 token 拿不到这个 key（见 api.ts listHotels 的 token 参数），
      // 此处 ?? null 兜底成"未录"而不是误当 0。
      costPriceCny: rt.costPriceCny != null ? Number(rt.costPriceCny) : null,
    })),
  };
}

function transferApiToMock(t: ApiTransfer): MockTransferWithCost {
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
    costPriceCny: t.costPriceCny != null ? Number(t.costPriceCny) : null,
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
    // 使馆/代办成本（仅内部）：匿名/未带 token 拿不到这个 key，?? null 兜底成"未录"。
    costPriceCny: v.costPriceCny != null ? Number(v.costPriceCny) : null,
    // 签发方式 / 入境次数（结构化分类）：未设置（含旧数据未回填命中）= null
    issuanceMethod: v.issuanceMethod,
    entryType: v.entryType,
    // 签证公司/代办渠道名（财务对账用）；未录为 null
    supplier: v.supplier,
    // 加急档位表；后端恒下发数组（[] = 未配分档），?? [] 兜住老版本后端不带该字段的情况。
    expressTiers: v.expressTiers ?? [],
  };
}

function bundleApiToMock(b: ApiBundle): MockBundleWithServiceNotes {
  const items = (b.items as BundleItem[]) ?? [];
  // 原价参考 = 各项合计（机票行 unitPrice 在 DB 为 0 → 此处仅地面参考；真实全包价含实时机票，在前台/下单时算）。
  // 套餐价 = 原价 ×(1 − discountPct/100)；折扣是套餐唯一口径。
  const discountPct = b.discountPct ?? 0;
  // 原价 = 含当前最低机票的全包原价（后端 originalAllInCny）；旧数据/无机票估值时回退 items 合计。
  // 仅作参考锚点保留（卡片不再展示整包口径——0702 反馈：与每人起价同框打架，已统一为折后起价/人）。
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
    // 每人操作费（服务端恒返回 number，DB 默认 ¥20）；?? 20 只防老缓存缺字段。
    operationFeeCny: b.operationFeeCny ?? 20,
    infantPriceCny: b.infantPriceCny,
    legs: b.legs,
    blackoutDates: b.blackoutDates ?? [],
    defaultDepartDate: b.defaultDepartDate ?? null,
    outboundFlight: b.outboundFlight ?? null,
    returnFlight: b.returnFlight ?? null,
    // 管理端可编辑排序值：数字小的排前面（列表 + 录单套餐下拉同口径）；null = 排最后
    sortOrder: b.sortOrder,
    // 结算价日历取价键（都配了才走日历取价）
    settlementTier: b.settlementTier ?? null,
    settlementNights: b.settlementNights ?? null,
  };
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
  /** 净房价（¥/晚，仅内部）：套餐向导「地面成本估算」用；未录/无权限看到 → null，绝不按 basePrice 估算替代。 */
  costPriceCny: number | null;
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

/**
 * 0702 反馈 3「报错吞字段」：后端校验失败时已经把 details.fieldErrors（zod flatten()，
 * 见 backend error-handler.ts）放进响应体，ApiError 也早就存了 .details（见 api.ts），
 * 但四个 persist* 的 catch 只读了 e.message，具体哪个字段不合规被吞掉——运营看到
 * "保存失败：Request validation failed" 却猜不出改哪。这里把 fieldErrors 逐条拼进提示。
 */
function formatApiError(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const details = e.details as { fieldErrors?: Record<string, string[] | undefined> } | undefined;
  const fieldErrors = details?.fieldErrors ?? {};
  const lines = Object.entries(fieldErrors)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0)
    .map(([field, msgs]) => `· ${field}：${msgs.join('；')}`);
  return lines.length > 0 ? `${fallback}：${e.message}\n${lines.join('\n')}` : `${fallback}：${e.message}`;
}

export function ProductsPage() {
  const tokens = useAuth((s) => s.tokens);
  const [section, setSection] = useState<Section>('hotels');
  const [hotels, setHotels] = useState<MockHotelWithCost[]>([]);
  const [transfers, setTransfers] = useState<MockTransferWithCost[]>([]);
  const [visas, setVisas] = useState<MockVisaWithStayDays[]>([]);
  const [bundles, setBundles] = useState<MockBundleWithServiceNotes[]>([]);
  const [roomTypeOptions, setRoomTypeOptions] = useState<RoomTypeOption[]>([]);
  // 套餐可绑定的航班号选项（去程/回程下拉用）。仅在售航班。
  const [flightOptions, setFlightOptions] = useState<FlightOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tk = tokens?.accessToken ?? '';

  /**
   * 四类产品各自独立落地（allSettled，不是 all）。
   *
   * 旧写法用 Promise.all：任意一个接口失败（哪怕只是令牌续期撞上并发轮换的瞬时故障），
   * 整个 then 被跳过 → 四个列表一个都不 setState → 每个 tab 计数全是 0，看着像"产品全没了"。
   * 现在逐个结算：成功的照常落地，失败的**保留该列表已有数据**，只把失败的分类汇总成一条提示。
   */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([
      // 带 tk：匿名/游客拿不到 costPriceCny（0702 反馈 6·成本泄漏修复），本页是后台运营页，
      // 必须带 ADMIN/STAFF token 才能看到/编辑成本价——否则「成本价进产品表单」的读回路会一直是空的。
      api.listHotels(false, tk),
      api.listTransfers(false, tk),
      api.listVisas(false, tk),
      api.listBundles(false),
      api.listAllFlights(tk),
    ])
      .then(([hR, tR, vR, bR, fR]) => {
        if (cancelled) return;
        const failed: string[] = [];

        if (hR.status === 'fulfilled') {
          const activeHotels = activeOnly(hR.value.hotels);
          setHotels(activeHotels.map(hotelApiToMock));
          setRoomTypeOptions(
            activeHotels.flatMap((ht) =>
              ht.roomTypes.map((rt) => ({
                id: rt.id,
                label: `${ht.name} · ${rt.name}`,
                // 整间夜价 = 房型自身 basePrice（服务端权威取价源，与 hotelRoomType.nightlyPriceCny 落库口径一致）。
                nightlyPriceCny: Math.round(Number(rt.basePrice)),
                costPriceCny: rt.costPriceCny != null ? Number(rt.costPriceCny) : null,
              })),
            ),
          );
        } else failed.push('酒店');

        if (tR.status === 'fulfilled') setTransfers(activeOnly(tR.value.transfers).map(transferApiToMock));
        else failed.push('地面服务');

        if (vR.status === 'fulfilled') setVisas(activeOnly(vR.value.visas).map(visaApiToMock));
        else failed.push('签证');

        if (bR.status === 'fulfilled') setBundles(activeOnly(bR.value.bundles).map(bundleApiToMock));
        else failed.push('套餐');

        // 航班号下拉是套餐表单的辅助项，拉不到就留空，不计入加载失败（沿用原有兜底口径）。
        if (fR.status === 'fulfilled') setFlightOptions(flightsToOptions(fR.value.flights));

        const firstReason = [hR, tR, vR, bR].find((r) => r.status === 'rejected') as
          | PromiseRejectedResult
          | undefined;
        setError(
          failed.length === 0
            ? null
            : `${failed.join('、')}加载失败（已保留上次数据，可点左侧「产品管理」重试）：${
                firstReason?.reason instanceof ApiError ? firstReason.reason.message : '网络异常'
              }`,
        );
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 保存失败后的收尾：先以服务端为准重拉一次，拉到就用服务端真值，拉不到才回滚到本地旧值。
   *
   * 直接回滚 prev 会说谎 —— 写入其实已经成功、只是收尾的重拉失败时（例如令牌恰好在这一刻过期），
   * 列表会把刚建好的记录抹掉：运营以为没保存上，于是再建一遍，服务端就多出一条重复记录。
   */
  async function refetchOrRollback<T>(
    refetch: () => Promise<T[]>,
    apply: (rows: T[]) => void,
    rollback: () => void,
  ): Promise<void> {
    try {
      apply(await refetch());
    } catch {
      rollback();
    }
  }

  async function persistHotels(next: MockHotelWithCost[]) {
    const prev = hotels;
    setHotels(next);
    try {
      for (const old of prev) if (!next.find((n) => n.id === old.id)) await api.deleteHotel(tk, old.id);
      for (const n of next) if (!prev.find((p) => p.id === n.id)) {
        await api.createHotel(tk, {
          name: n.name, nameEn: n.nameEn, cityCode: n.cityCode, area: n.area,
          address: n.address || n.area, starRating: n.stars, intlFiveStar: n.intlFiveStar ?? false,
          designationSurchargeCnyPerPerson: n.designationSurchargeCnyPerPerson ?? 0, basePrice: n.basePrice,
          // 0702 反馈 2：rating 不再回传——serializeHotel 现在发 {average,count} 聚合对象，
          // 表单本就没有编辑评分的入口；旧代码 Number(对象)=NaN，JSON 序列化成 null，
          // 后端 z.number() 校验直接拒绝（"酒店编辑全挂"根因）。评分改由 Review 真实评价聚合，
          // 不该也不能由本表单手改。
          reviewCount: n.reviewCount, emoji: n.emoji,
          highlight: n.highlight, amenities: n.amenities, photos: hotelPhotos(n),
          roomTypes: n.roomTypes.map((rt) => ({
            name: rt.name, bedType: rt.bedType, capacity: rt.sleeps,
            basePrice: n.basePrice * rt.priceMult, priceMultiplier: rt.priceMult,
            maxAdults: rt.maxAdults ?? 2, maxChildren: rt.maxChildren ?? 1,
            // 净房价（仅内部，前台不展示）：留空 = 未录 → 省略字段（房型行是整行覆盖式提交，
            // 后端把"省略"当"未录"清空，语义上与"不改"无关——新建本就没有"不改"这回事）。
            costPriceCny: rt.costPriceCny ?? undefined,
          })),
        });
      }
      for (const n of next) {
        const old = prev.find((p) => p.id === n.id);
        if (old && JSON.stringify(old) !== JSON.stringify(n)) {
          await api.updateHotel(tk, n.id, {
            name: n.name, nameEn: n.nameEn, cityCode: n.cityCode, area: n.area,
            address: n.address || n.area, starRating: n.stars, intlFiveStar: n.intlFiveStar ?? false,
            designationSurchargeCnyPerPerson: n.designationSurchargeCnyPerPerson ?? 0,
            basePrice: n.basePrice, reviewCount: n.reviewCount,
            emoji: n.emoji, highlight: n.highlight, amenities: n.amenities,
            photos: hotelPhotos(n),
            roomTypes: n.roomTypes.map((rt) => ({
              name: rt.name, bedType: rt.bedType, capacity: rt.sleeps,
              basePrice: n.basePrice * rt.priceMult, priceMultiplier: rt.priceMult,
              maxAdults: rt.maxAdults ?? 2, maxChildren: rt.maxChildren ?? 1,
              // 留空 = 清空成本价（房型行整行覆盖式提交；表单已用现值预填，未改动就会原样送回）。
              costPriceCny: rt.costPriceCny ?? undefined,
            })),
          });
        }
      }
      const fresh = await api.listHotels(false, tk);
      setHotels(activeOnly(fresh.hotels).map(hotelApiToMock));
    } catch (e) {
      alert(formatApiError(e, '保存失败'));
      await refetchOrRollback(
        async () => activeOnly((await api.listHotels(false, tk)).hotels).map(hotelApiToMock),
        setHotels,
        () => setHotels(prev),
      );
    }
  }

  async function persistTransfers(next: MockTransferWithCost[]) {
    const prev = transfers;
    setTransfers(next);
    try {
      for (const old of prev) if (!next.find((n) => n.id === old.id)) await api.deleteTransfer(tk, old.id);
      for (const n of next) if (!prev.find((p) => p.id === n.id)) {
        await api.createTransfer(tk, {
          name: n.name, vehicleType: n.vehicleType, capacity: n.capacity,
          originArea: n.originArea, destArea: n.destArea, basePrice: n.basePrice,
          features: n.features, duration: n.duration, emoji: n.emoji,
          // 0702 反馈 1「保存失败」根因：photo 是 z.string().url().optional()，空字符串不是合法 URL，
          // 也不是"没填"——两者对 zod 是两码事。留空时必须整体不传这个键（mirror 下面 highlight
          // 同款「假值 → undefined」写法），而不是发送 ''。
          photo: n.photo || undefined,
          // 净房价（仅内部，前台不展示）：留空 = 未录 → 省略字段。
          costPriceCny: n.costPriceCny ?? undefined,
        });
      }
      for (const n of next) {
        const old = prev.find((p) => p.id === n.id);
        if (old && JSON.stringify(old) !== JSON.stringify(n)) {
          await api.updateTransfer(tk, n.id, {
            // basePrice 曾漏传：与 createTransfer 字段列表不一致，导致「编辑」改了起步价、
            // PATCH 200 但价格没变（后端 undefined 字段=不改，静默丢弃）——0702 反馈的真实根因。
            name: n.name, vehicleType: n.vehicleType, capacity: n.capacity,
            originArea: n.originArea, destArea: n.destArea, basePrice: n.basePrice,
            features: n.features, duration: n.duration, emoji: n.emoji,
            photo: n.photo || undefined,
            // 留空 = 显式清空成本价（真·部分更新字段，null 会被后端当"主动清空"而非"不改"，
            // 见 backend products.service.ts updateTransfer；表单已用现值预填，未改动会原样送回）。
            costPriceCny: n.costPriceCny ?? null,
          });
        }
      }
      const fresh = await api.listTransfers(false, tk);
      setTransfers(activeOnly(fresh.transfers).map(transferApiToMock));
    } catch (e) {
      alert(formatApiError(e, '保存失败'));
      await refetchOrRollback(
        async () => activeOnly((await api.listTransfers(false, tk)).transfers).map(transferApiToMock),
        setTransfers,
        () => setTransfers(prev),
      );
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
          // 使馆/代办成本（仅内部，前台不展示）：留空 = 未录 → 省略字段。
          costPriceCny: n.costPriceCny ?? undefined,
          // 签发方式 / 入境次数（结构化分类，选填）：留空 = 未设置 → 省略字段。
          issuanceMethod: n.issuanceMethod ?? undefined,
          entryType: n.entryType ?? undefined,
          // 签证公司/代办渠道名（选填，仅内部，财务对账用）：留空 = 未录 → 省略字段。
          supplier: n.supplier || undefined,
          // 加急档位表（选填）：空表 = 不提供分档加急（回落单值「加急附加费」）。
          expressTiers: n.expressTiers ?? [],
        });
      }
      for (const n of next) {
        const old = prev.find((p) => p.id === n.id);
        if (old && JSON.stringify(old) !== JSON.stringify(n)) {
          await api.updateVisa(tk, n.id, {
            // basePrice 曾漏传：与 createVisa 字段列表不一致，导致「编辑」改了办理费、
            // PATCH 200 但价格没变（后端 undefined 字段=不改，静默丢弃）——与 Transfer 同一类缺陷。
            country: n.country, flag: n.flag, visaName: n.type,
            processingDays: n.processingDays, basePrice: n.basePrice, expressSurcharge: n.expressSurcharge,
            validityMonths: n.validityMonths, highlight: n.highlight,
            requiredDocs: n.requiredDocs,
            stayDays: n.stayDays ?? undefined,
            // 留空 = 显式清空成本价（真·部分更新字段，语义同 Transfer；表单已用现值预填）。
            costPriceCny: n.costPriceCny ?? null,
            // 留空 = 显式清空签发方式/入境次数为未设置（同款真·部分更新字段）。
            issuanceMethod: n.issuanceMethod ?? null,
            entryType: n.entryType ?? null,
            // 留空 = 显式清空签证公司为未录（真·部分更新字段，表单已用现值预填）。
            supplier: n.supplier || null,
            // 加急档位表整表覆盖（表单已用现值预填）：删空 = 传 []，即清掉分档、回落单值加急费。
            expressTiers: n.expressTiers ?? [],
          });
        }
      }
      const fresh = await api.listVisas(false, tk);
      setVisas(activeOnly(fresh.visas).map(visaApiToMock));
    } catch (e) {
      alert(formatApiError(e, '保存失败'));
      await refetchOrRollback(
        async () => activeOnly((await api.listVisas(false, tk)).visas).map(visaApiToMock),
        setVisas,
        () => setVisas(prev),
      );
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
          // 升舱差价：留空 = null =「跟随航班」（计价时取绑定航班的每程差价）；显式数值 = 套餐自有覆盖（含 0=不提供）。
          businessUpgradeCnyPerLeg: n.businessUpgradeCnyPerLeg ?? null,
          childSeatDiscountCnyPerPerson: n.childSeatDiscountCnyPerPerson ?? null,
          selfVisaDeductCny: n.selfVisaDeductCny ?? null,
          // 显式发数值：null 会被更新路径当「不改」，改回默认就改不动。
          operationFeeCny: n.operationFeeCny ?? 20,
          infantPriceCny: n.infantPriceCny ?? null,
          legs: n.legs ?? 2,
          blackoutDates: n.blackoutDates ?? [],
          defaultDepartDate: n.defaultDepartDate ?? null,
          // 绑定航班号（去程/回程）：选了 = flight.id；不指定 = null。
          outboundFlightId: n.outboundFlight?.id ?? null,
          returnFlightId: n.returnFlight?.id ?? null,
          // 管理端可编辑排序值（选填）：留空 = 排最后 → 省略字段。
          sortOrder: n.sortOrder ?? undefined,
          // 结算价日历取价键：档次 + 晚数（表单已保证两者同填/同空）；不走日历 = null。
          settlementTier: n.settlementTier ?? null,
          settlementNights: n.settlementNights ?? null,
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
            // 升舱差价：留空 = null =「跟随航班」；显式数值 = 套餐自有覆盖（含 0=不提供）。更新路径 !==undefined 才写入，
            // 显式 null 会写入（改回跟随航班），显式 0 会写入（不提供升舱）。
            businessUpgradeCnyPerLeg: n.businessUpgradeCnyPerLeg ?? null,
            childSeatDiscountCnyPerPerson: n.childSeatDiscountCnyPerPerson ?? null,
            selfVisaDeductCny: n.selfVisaDeductCny ?? null,
            // 显式发数值：null 会被更新路径当「不改」，改回默认就改不动。
            operationFeeCny: n.operationFeeCny ?? 20,
            infantPriceCny: n.infantPriceCny ?? null,
            legs: n.legs ?? 2,
            blackoutDates: n.blackoutDates ?? [],
            defaultDepartDate: n.defaultDepartDate ?? null,
            // 绑定航班号（去程/回程）：选了 = flight.id；不指定 = null（解绑）。
            outboundFlightId: n.outboundFlight?.id ?? null,
            returnFlightId: n.returnFlight?.id ?? null,
            // 留空 = 显式清空排序值为未设（排最后，真·部分更新字段，表单已用现值预填）。
            sortOrder: n.sortOrder ?? null,
            // 结算价日历取价键：显式 null = 退出日历取价（表单已保证档次+晚数同填/同空）。
            settlementTier: n.settlementTier ?? null,
            settlementNights: n.settlementNights ?? null,
            isActive: n.active,
          });
        }
      }
      const fresh = await api.listBundles(false);
      setBundles(activeOnly(fresh.bundles).map(bundleApiToMock));
    } catch (e) {
      alert(formatApiError(e, '保存失败'));
      await refetchOrRollback(
        async () => activeOnly((await api.listBundles(false)).bundles).map(bundleApiToMock),
        setBundles,
        () => setBundles(prev),
      );
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
          token={tk}
          onChange={persistBundles}
        />
      )}
    </div>
  );
}

// ─── 新增/编辑表单的互斥状态 + 弹框外壳（酒店 / 接送 / 签证共用） ───────
/**
 * 卡片列表小节（酒店/接送/签证）统一用这个 union 类型管理「新增表单」「编辑表单」的显隐，
 * 天然互斥——同一时刻只可能是 closed / new / edit 三者之一，不会出现新增和编辑表单同时挂载。
 */
type FormMode<T> = { type: 'closed' } | { type: 'new' } | { type: 'edit'; item: T };

/** 新增/编辑表单的弹框外壳：遮罩层 + 居中卡片，点遮罩层或按 Esc 关闭；点表单内部不冒泡关闭。 */
function FormModal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// ─── 酒店 ───────────────────────────────────────────────────────────
function HotelsSection({ items, onChange }: { items: MockHotelWithCost[]; onChange: (v: MockHotelWithCost[]) => void }) {
  // 互斥：同一时刻只可能是「关闭」「新增」「编辑某一项」之一，从根上杜绝新增/编辑表单同时出现。
  const [mode, setMode] = useState<FormMode<MockHotelWithCost>>({ type: 'closed' });
  const closeModal = () => setMode({ type: 'closed' });
  return (
    <div className="space-y-3">
      <ActionBar active={items.length} onAdd={() => setMode({ type: 'new' })} addLabel="+ 新增酒店" />
      {mode.type !== 'closed' && (
        <FormModal onClose={closeModal}>
          {mode.type === 'edit' ? (
            // key=编辑目标 id：强制每次「编辑」都重挂载表单，用最新 hotel 重新播种内部 state。
            // 缺 key 时表单实例被复用，新建酒店后刷新列表（id 变、对象换新）会让二次编辑打不开/带旧数据。
            <EditHotelForm
              key={mode.item.id}
              hotel={mode.item}
              onCancel={closeModal}
              onSave={(h) => { onChange(items.map((x) => x.id === h.id ? h : x)); closeModal(); }}
            />
          ) : (
            <NewHotelForm
              onCancel={closeModal}
              onSubmit={(h) => { onChange([h, ...items]); closeModal(); }}
            />
          )}
        </FormModal>
      )}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {items.map((h) => (
          <div key={h.id} className="card transition hover:shadow-pop">
            <div className="font-mono text-xs text-ink-muted">编号 {h.code ?? '—'} <span className="font-sans not-italic text-ink-muted">(系统自动生成)</span></div>
            <div className="flex items-start justify-between">
              <div className="text-3xl">{h.emoji}</div>
              <span className="badge-warning">
                {'★'.repeat(h.stars)} {h.intlFiveStar ? '国际五星' : `${h.stars}星`}
              </span>
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
                <button className="font-medium text-brand hover:text-brand-dark" onClick={() => setMode({ type: 'edit', item: h })}>编辑</button>
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
  onSubmit: (h: MockHotelWithCost) => void;
}) {
  const blank: MockHotelWithCost = {
    id: 'h-' + Date.now(),
    name: '',
    nameEn: '',
    cityCode: 'DAD',
    area: '美溪海滩',
    address: '',
    stars: 4,
    intlFiveStar: false,
    designationSurchargeCnyPerPerson: 0,
    basePrice: 880,
    rating: 4.5,
    reviewCount: 0,
    emoji: '🏨',
    photo: '',
    photos: [],
    amenities: ['免费 WiFi', '含早餐'],
    highlight: '',
    roomTypes: [{ name: '标准房', priceMult: 1, sleeps: 2, bedType: '双床或大床', maxAdults: 2, maxChildren: 1, costPriceCny: null }],
  };
  return (
    <HotelEditorForm hotel={blank} title="新增酒店" submitLabel="添加" onCancel={onCancel} onSave={onSubmit} />
  );
}

// ─── 接送 ───────────────────────────────────────────────────────────
function TransfersSection({ items, onChange }: { items: MockTransferWithCost[]; onChange: (v: MockTransferWithCost[]) => void }) {
  // 互斥：同一时刻只可能是「关闭」「新增」「编辑某一项」之一，从根上杜绝新增/编辑表单同时出现。
  const [mode, setMode] = useState<FormMode<MockTransferWithCost>>({ type: 'closed' });
  const closeModal = () => setMode({ type: 'closed' });
  return (
    <div className="space-y-3">
      {mode.type !== 'closed' && (
        <FormModal onClose={closeModal}>
          {mode.type === 'edit' ? (
            // key=编辑目标 id：强制每次「编辑」都重挂载表单，用最新对象重新播种内部 state。
            // 缺 key 时表单实例被复用，新建后刷新列表（id 变、对象换新）会让二次编辑打不开/带旧数据。
            <EditTransferForm
              key={mode.item.id}
              transfer={mode.item}
              onCancel={closeModal}
              onSave={(t) => { onChange(items.map((x) => x.id === t.id ? t : x)); closeModal(); }}
            />
          ) : (
            <NewTransferForm
              onCancel={closeModal}
              onSubmit={(t) => { onChange([t, ...items]); closeModal(); }}
            />
          )}
        </FormModal>
      )}
      <ActionBar active={items.length} onAdd={() => setMode({ type: 'new' })} addLabel="+ 新增车型" />
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
                <button className="font-medium text-brand hover:text-brand-dark" onClick={() => setMode({ type: 'edit', item: t })}>编辑</button>
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
  // 互斥：同一时刻只可能是「关闭」「新增」「编辑某一项」之一，从根上杜绝新增/编辑表单同时出现。
  const [mode, setMode] = useState<FormMode<MockVisaWithStayDays>>({ type: 'closed' });
  const closeModal = () => setMode({ type: 'closed' });
  return (
    <div className="space-y-3">
      {mode.type !== 'closed' && (
        <FormModal onClose={closeModal}>
          {mode.type === 'edit' ? (
            // key=编辑目标 id：强制每次「编辑」都重挂载表单，用最新对象重新播种内部 state。
            // 缺 key 时表单实例被复用，新建后刷新列表（id 变、对象换新）会让二次编辑打不开/带旧数据。
            <EditVisaForm
              key={mode.item.id}
              visa={mode.item}
              onCancel={closeModal}
              onSave={(v) => { onChange(items.map((x) => x.id === v.id ? v : x)); closeModal(); }}
            />
          ) : (
            <NewVisaForm
              onCancel={closeModal}
              onSubmit={(v) => { onChange([v, ...items]); closeModal(); }}
            />
          )}
        </FormModal>
      )}
      <ActionBar active={items.length} onAdd={() => setMode({ type: 'new' })} addLabel="+ 新增签证产品" />
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
                <button className="font-medium text-brand hover:text-brand-dark" onClick={() => setMode({ type: 'edit', item: v })}>编辑</button>
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
  token,
  onChange,
}: {
  items: MockBundleWithServiceNotes[];
  roomTypeOptions: RoomTypeOption[];
  flightOptions: FlightOption[];
  /** 接送产品下拉选项（在售）；套餐 TRANSFER 组件只能挑产品，不再手填价 */
  transfers: MockTransferWithCost[];
  /** 签证产品下拉选项（在售）；套餐 VISA 组件只能挑产品，不再手填价 */
  visas: MockVisaWithStayDays[];
  /** ADMIN/STAFF token：套餐表单据此调 /products/bundles/flight-ref 取本套餐机票参考价 */
  token: string;
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
          token={token}
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
          token={token}
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
  // 折后起价/人 = originalPerPaxCny ×(1−discountPct/100)。卡片唯一价格口径（0702 反馈：
  // 旧「单买总价/套餐价」块按 flightPax 整包口径（如 3376/3207），与每人起价同框互相打架，已移除）。
  const cardDiscountPct = bundle.discountPct ?? 0;
  const cardOriginalPerPax = bundle.originalPerPaxCny ?? 0;
  const cardDiscountedPerPax = Math.round(cardOriginalPerPax * (1 - cardDiscountPct / 100));
  // 机票口径：来回 = 去程(单程) + 回程(单程)；拆开显示，避免把来回价误当单程。
  const flight = bundleFlightRoundTrip(bundle);
  // 防御：items 非数组等畸形形状（历史脏数据）时安全兜底为 []，不让一条坏数据挂掉整卡渲染。
  const safeBundleItems = Array.isArray(bundle.items) ? bundle.items : [];
  // 起价拆解（0702 反馈：运营把 1400=经济舱700×2 误读成「升舱默认700×2」，此处逐项摊开）：
  // 与向导里的 originalPerPaxBreakdown 用同一份权威数据（items 已是服务端定价、hotelNights 已落库），
  // 四项相加 = bundle.originalPerPaxCny（服务端 computeBundleOriginalPerPaxCny 的同一份口径）。
  const nightsForBreakdown = bundle.hotelNights ?? 0;
  const hotelRoomTypeWithPrice = bundle.hotelRoomType as BundleHotelRoomTypeWithPrice | null | undefined;
  const hotelNightlyForBreakdown = hotelRoomTypeWithPrice?.nightlyPriceCny ?? 0;
  const hotelHalfShareForBreakdown = Math.round(0.5 * hotelNightlyForBreakdown * nightsForBreakdown);
  const transferTotalForBreakdown = safeBundleItems
    .filter((i) => i.kind === 'TRANSFER')
    .reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const transferTripsForBreakdown = safeBundleItems
    .filter((i) => i.kind === 'TRANSFER')
    .reduce((s, i) => s + i.qty, 0);
  const visaPerPaxForBreakdown = safeBundleItems
    .filter((i) => i.kind === 'VISA')
    .reduce((s, i) => s + i.unitPrice, 0);
  // 每人操作费（服务端起价已含；起价是 1 人口径 → 直接加一次，不乘人数）。
  const operationFeeForBreakdown = Math.max(0, bundle.operationFeeCny ?? 20);
  const originalPerPaxBreakdown = [
    flight && flight.roundTrip > 0 ? { label: '机票往返(经济舱最低)', amount: flight.roundTrip } : null,
    hotelHalfShareForBreakdown > 0
      ? { label: `酒店 0.5间×${nightsForBreakdown}晚`, amount: hotelHalfShareForBreakdown }
      : null,
    transferTotalForBreakdown > 0
      ? { label: `接送 ${transferTripsForBreakdown}趟`, amount: transferTotalForBreakdown }
      : null,
    visaPerPaxForBreakdown > 0 ? { label: '签证', amount: visaPerPaxForBreakdown } : null,
    operationFeeForBreakdown > 0 ? { label: '操作费/人', amount: operationFeeForBreakdown } : null,
  ].filter((row): row is { label: string; amount: number } => row != null);
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
              // 机票不在套餐里逐项定价（随出发日实时浮动，已含在原价）→ 标「往返」而非 ¥0，不展示 qty。
              <span className="text-ink-muted whitespace-nowrap">往返（去+回两程）</span>
            ) : i.kind === 'VISA' ? (
              // 签证按 1 人计入起价，qty 不影响单价 → 展示「/人」而非误导性的 qty×单价。
              <span className="text-ink-muted nums whitespace-nowrap">¥{i.unitPrice.toLocaleString()}/人</span>
            ) : (
              // 酒店行按双人拼房半间展示（单价/小计都是 unitPrice 的一半）——落库的 unitPrice 仍是整间夜价，
              // 只是这里展示换算，不改任何存量数值；与下方起价拆解的「酒店 0.5间×N晚」口径保持一致。
              <span className="text-ink-muted nums whitespace-nowrap">
                {i.kind === 'HOTEL'
                  ? `${i.qty} 晚 × ¥${Math.round(i.unitPrice / 2).toLocaleString()}/晚·半间 = ¥${Math.round((i.qty * i.unitPrice) / 2).toLocaleString()}`
                  : `${i.qty} 趟 × ¥${i.unitPrice}/趟 = ¥${(i.qty * i.unitPrice).toLocaleString()}`}
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

      {/* 可选加项：单房差 / 升舱 / 儿童差价 / 婴儿价 / 自备签证减额 —— 都是买家下单时可另加购的升级项，
          不是套餐组件，不计入下方「起价」。0702 反馈：运营把这行里的 700 误读成「升舱默认包含在起价里」，
          明确打标签避免再混淆。升舱 ¥0（= 未设置/不提供）不展示——避免读成「升舱免费」。 */}
      {(bundle.singleSupplementCnyPerNight != null ||
        bundle.businessUpgradeCnyPerLeg == null ||
        bundle.businessUpgradeCnyPerLeg > 0) && (
        <div className="mt-1 text-xs text-ink-soft">
          <span className="mr-1 rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-ink-muted">可选加项 · 不计入起价</span>
          {bundle.singleSupplementCnyPerNight != null && (
            <>🛏️ 单房差 ¥{bundle.singleSupplementCnyPerNight.toLocaleString()}/晚</>
          )}
          {bundle.singleSupplementCnyPerNight != null &&
            (bundle.businessUpgradeCnyPerLeg == null || bundle.businessUpgradeCnyPerLeg > 0) &&
            ' · '}
          {bundle.businessUpgradeCnyPerLeg == null ? (
            // null = 跟随航班：升舱差价随绑定航班浮动，不写死在套餐上。
            <>💺 升舱 跟随航班</>
          ) : (
            bundle.businessUpgradeCnyPerLeg > 0 && (
              // 只显示单价，不显示「× N 段」——任何乘法样式都会被读成「已计入价格」；
              // 按段合计只在买家真正选购升舱时（前台加购器/订单）出现。
              <>💺 升舱 ¥{bundle.businessUpgradeCnyPerLeg.toLocaleString()}/程</>
            )
          )}
        </div>
      )}

      {(bundle.childSeatDiscountCnyPerPerson != null || bundle.infantPriceCny != null || (bundle.selfVisaDeductCny != null && bundle.selfVisaDeductCny > 0)) && (
        <div className="mt-1 text-xs text-ink-soft">
          <span className="mr-1 rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-ink-muted">可选加项 · 不计入起价</span>
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
            起价 / 人<span className="ml-1 text-xs text-ink-muted">(拼房)</span>
          </span>
          <div className="text-right">
            {cardDiscountPct > 0 && (
              <span className="mr-2 text-sm text-ink-muted line-through nums">¥{cardOriginalPerPax.toLocaleString()}</span>
            )}
            <span className="text-2xl font-semibold text-brand-700 nums">
              ¥{cardDiscountedPerPax.toLocaleString()}
            </span>
            {cardDiscountPct > 0 && <span className="badge-danger ml-2">省 {cardDiscountPct}%</span>}
          </div>
        </div>
        {originalPerPaxBreakdown.length > 0 && (
          // 起价拆解：同一份权威数据算出，逐项相加 = 原价起价；折扣在尾部标明（买家价 = 大字）。
          <p className="mt-1 text-right text-[11px] leading-relaxed text-ink-muted nums">
            = {originalPerPaxBreakdown.map((row) => `${row.label} ¥${row.amount.toLocaleString()}`).join(' + ')} /人
            {cardDiscountPct > 0 && ` → 省 ${cardDiscountPct}% = ¥${cardDiscountedPerPax.toLocaleString()}/人`}
          </p>
        )}
        <p className="mt-1 text-right text-[11px] text-ink-muted">
          双人拼房价 · 单人独住+单房差 · 实际按出发日实时机票浮动
        </p>
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
  token,
  onCancel,
  onSubmit,
}: {
  roomTypeOptions: RoomTypeOption[];
  /** 可绑定的航班号选项（去程/回程下拉）；value = flight.id */
  flightOptions: FlightOption[];
  /** 接送产品下拉选项（在售）；TRANSFER 组件只能挑产品，价格只读来自产品 */
  transfers: MockTransferWithCost[];
  /** 签证产品下拉选项（在售）；VISA 组件只能挑产品，价格只读来自产品 */
  visas: MockVisaWithStayDays[];
  /** 传入既有套餐 = 编辑模式（各字段预填）；缺省 = 新建 */
  initial?: MockBundleWithServiceNotes;
  /** ADMIN/STAFF token：据此调 /products/bundles/flight-ref 按「本套餐自己的绑定」取机票参考价 */
  token: string;
  onCancel: () => void;
  onSubmit: (b: MockBundleWithServiceNotes) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [tagline, setTagline] = useState(initial?.tagline ?? '');
  // 服务内容（订单详情行程单「服务内容」板块用；每行一条，选填）
  const [serviceNotes, setServiceNotes] = useState(initial?.serviceNotes ?? '');
  const [emoji, setEmoji] = useState(initial?.emoji ?? '🎁');
  const [suitableFor, setSuitableFor] = useState(initial?.suitableFor ?? '2 大人');
  // 管理端可编辑排序值（选填）：数字小的排前面，留空排最后（列表 + 录单套餐下拉同口径）
  const [sortOrder, setSortOrder] = useState<number | null>(initial?.sortOrder ?? null);
  const [hotelRoomTypeId, setHotelRoomTypeId] = useState(initial?.hotelRoomTypeId ?? '');
  // 住宿晚数 = 唯一真源：同时驱动 hotelNights + 首个 HOTEL 项的 qty。
  // 预填：旧数据 hotelNights 可能为 null，回退到 HOTEL 项 qty，再回退 1。
  const initialFirstHotelQty = initial?.items.find((it) => it.kind === 'HOTEL')?.qty ?? null;
  const initialNights = initial ? initial.hotelNights ?? initialFirstHotelQty ?? 1 : 3;
  const [hotelNights, setHotelNights] = useState<number | null>(initialNights);
  // 不可售日期（blackout，按出发日，单套餐粒度）+ 前台默认出发日
  const [blackoutDates, setBlackoutDates] = useState<BlackoutDateRow[]>(initial?.blackoutDates ?? []);
  const [defaultDepartDate, setDefaultDepartDate] = useState<string>(initial?.defaultDepartDate ?? '');
  // 结算价日历取价键（选填）：档次 + 晚数都配了，代理下该套餐单才按去程出发日期自动取每人结算价。
  //   任一为空 = 该套餐不走日历（现状不变，代理单沿用系统权威价）。
  const [settlementTier, setSettlementTier] = useState<SettlementTier | ''>(initial?.settlementTier ?? '');
  const [settlementNights, setSettlementNights] = useState<number | null>(initial?.settlementNights ?? null);
  // 绑定航班号（去程/回程）：存 flight.id，空串 = 不指定（按最便宜航班）。编辑时从已绑航班预填。
  const [outboundFlightId, setOutboundFlightId] = useState<string>(initial?.outboundFlight?.id ?? '');
  const [returnFlightId, setReturnFlightId] = useState<string>(initial?.returnFlight?.id ?? '');
  // 机票参考价（起价 / 人公式里的机票项）—— 按「本套餐自己绑定的去/回程航班」实时取，与套餐卡片同源：
  //   • 唯一来源 = 后端 /products/bundles/flight-ref（内部即卡片起价用的 getCheapestRoundTripEconomyCny + 同一 binding），
  //     因此同一绑定下向导预览起价与卡片起价必然一致（修 A11「1560→1760」漂移的根因：旧逻辑从别的套餐借基数）。
  //   • 编辑初值先用卡片同款反推（bundleFlightRoundTrip 来自服务端 originalAllInCny，与端点同绑定同值），保证「打开即与卡片一致」，
  //     不用干等接口；接口就绪后覆盖成权威值（数值相同 → 无跳变）。新建初值 null（首查前机票项按 0）。
  const [flightRefRoundTripCny, setFlightRefRoundTripCny] = useState<number | null>(
    initial ? bundleFlightRoundTrip(initial)?.roundTrip ?? null : null,
  );
  const [flightRefLoading, setFlightRefLoading] = useState(false);
  const [flightRefError, setFlightRefError] = useState(false);
  // 打开表单 + 去/回程航班变化时，按当前绑定查机票参考价（300ms 防抖 + 竞态守卫：只认最后一次结果）。
  // 失败：提示（flightRefError）+ 保留已有基数不污染 —— 编辑保留卡片同款反推/上次成功值（避免瞬时网络抖动
  // 把机票项清零、再次引发起价漂移），新建首查失败时初值本就是 null（即「回退 null」）。
  useEffect(() => {
    if (!token) return;
    let stale = false;
    setFlightRefLoading(true);
    setFlightRefError(false);
    const timer = setTimeout(() => {
      api
        .getBundleFlightRef(token, {
          outboundFlightId: outboundFlightId || null,
          returnFlightId: returnFlightId || null,
        })
        .then((res) => {
          if (stale) return;
          setFlightRefRoundTripCny(res.flightRefRoundTripCny);
          setFlightRefLoading(false);
        })
        .catch(() => {
          if (stale) return;
          setFlightRefError(true);
          setFlightRefLoading(false);
        });
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [token, outboundFlightId, returnFlightId]);
  // 自愿升级展示价（CNY；留空 = 前台不展示该升级项）
  const [singleSupplement, setSingleSupplement] = useState<number | null>(initial?.singleSupplementCnyPerNight ?? null);
  const [businessUpgrade, setBusinessUpgrade] = useState<number | null>(initial?.businessUpgradeCnyPerLeg ?? null);
  // 大人/小孩区分（CNY；留空 = 用服务端默认：占座儿童差价 ¥30、婴儿价 ¥0）
  const [childSeatDiscount, setChildSeatDiscount] = useState<number | null>(initial?.childSeatDiscountCnyPerPerson ?? null);
  const [selfVisaDeduct, setSelfVisaDeduct] = useState<number | null>(initial?.selfVisaDeductCny ?? null);
  // 每人操作费：新建默认 ¥20（= DB 默认）；编辑回读已存值。提交时留空按 20 显式发数值。
  const [operationFee, setOperationFee] = useState<number | null>(initial?.operationFeeCny ?? 20);
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
    // 新建套餐默认给 1 个空白 HOTEL 行，productName 留空（未选房型时 SearchSelect 显示占位符，
    // 而不是一个看似已选中、其实没关联房型的假名字——避免重现向导截图里的「行有名字但没关联」陷阱）。
    return [{ kind: 'HOTEL', productName: '', qty: 3, unitPrice: 0 }];
  });
  // 房型整间夜价（¥/晚，只读展示 + 起价公式用）：未关联房型 → 0。
  const selectedRoomType = roomTypeOptions.find((o) => o.id === hotelRoomTypeId) ?? null;
  const hotelNightlyPriceCny = selectedRoomType?.nightlyPriceCny ?? 0;
  // 接送 / 签证组件价格权威来源 = 所挑产品的 basePrice（只读，运营不可手改）。
  const transferPriceById = useMemo(() => new Map(transfers.map((t) => [t.id, t.basePrice])), [transfers]);
  const visaPriceById = useMemo(() => new Map(visas.map((v) => [v.id, v.basePrice])), [visas]);
  // SearchSelect 选项（{id,label,priceLabel}）：房型行原有 label 已是「酒店名 · 房型名」，可直接搜两者；
  // 接送/签证的 priceLabel 用整数展示（basePrice 本身就是整数 CNY，见各自 mockData 定义）。
  const roomTypeSelectOptions: SearchSelectOption[] = useMemo(
    () => roomTypeOptions.map((o) => ({ id: o.id, label: o.label, priceLabel: String(o.nightlyPriceCny) })),
    [roomTypeOptions],
  );
  const transferSelectOptions: SearchSelectOption[] = useMemo(
    () => transfers.map((t) => ({ id: t.id, label: t.name, priceLabel: String(t.basePrice) })),
    [transfers],
  );
  const visaSelectOptions: SearchSelectOption[] = useMemo(
    () => visas.map((v) => ({ id: v.id, label: `${v.country} · ${v.type}`, priceLabel: String(v.basePrice) })),
    [visas],
  );
  // 地面合计（参考展示用，1 间房口径）：只算非机票行，价格取权威产品价（HOTEL 用整间夜价 × 晚数）。
  // VISA 按 1 人计入（qty 不影响单价），与起价公式里的 visaPerPax、行内小计展示口径三处保持一致——
  // 之前这里误按 qty×单价 算，会跟起价公式（忽略 qty）对不上。
  const listPrice = useMemo(
    () =>
      items.reduce((s, i) => {
        if (i.kind === 'FLIGHT') return s;
        if (i.kind === 'HOTEL') return s + hotelNightlyPriceCny * (i.qty ?? 0);
        if (i.kind === 'TRANSFER') return s + (i.transferId ? (transferPriceById.get(i.transferId) ?? 0) : 0) * (i.qty ?? 0);
        return s + (i.visaId ? (visaPriceById.get(i.visaId) ?? 0) : 0);
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
  // 每人操作费预览值（起价 1 人口径直接加一次；留空按 DB 默认 ¥20，与提交口径一致）。
  const operationFeePerPax = Math.max(0, operationFee ?? 20);
  const originalPerPax = Math.round(
    (flightRefRoundTripCny ?? 0) +
      0.5 * hotelNightlyPriceCny * nightsForPricing +
      transferTotal +
      visaPerPax +
      operationFeePerPax,
  );
  // 起价拆解（0702 反馈：运营把 1400=经济舱700×2 误读成「升舱默认700×2」；此处逐项摊开，
  // 每项都用起价公式本身的同一组变量算出，四项相加 = originalPerPax，杜绝口径分叉）。
  // 只列非零/非空项；接送凑「N 趟」= 各 TRANSFER 行 qty 之和（趟数，非产品数）。
  const transferTripsCount = useMemo(
    () => items.filter((i) => i.kind === 'TRANSFER').reduce((s, i) => s + (i.qty ?? 0), 0),
    [items],
  );
  const hotelHalfShareCny = Math.round(0.5 * hotelNightlyPriceCny * nightsForPricing);
  const originalPerPaxBreakdown = [
    flightRefRoundTripCny != null && flightRefRoundTripCny > 0
      ? { label: '机票往返(经济舱最低)', amount: flightRefRoundTripCny }
      : null,
    hotelHalfShareCny > 0
      ? { label: `酒店 0.5间×${nightsForPricing}晚`, amount: hotelHalfShareCny }
      : null,
    transferTotal > 0 ? { label: `接送 ${transferTripsCount}趟`, amount: transferTotal } : null,
    visaPerPax > 0 ? { label: '签证', amount: visaPerPax } : null,
    operationFeePerPax > 0 ? { label: '操作费/人', amount: operationFeePerPax } : null,
  ].filter((row): row is { label: string; amount: number } => row != null);

  // ── 地面成本估算（仅内部，0702 反馈 5d）—— 与上面「起价/人」卖价拆解完全独立的另一套数：
  // 用所挑产品的 costPriceCny（净成本，未录 = null）；绝不按 basePrice 打折估算替代
  // （DB 注释里"NULL 时按 basePrice×0.7 估算"那套是财务对账用的兜底口径，不该在这里悄悄复用，
  // 否则运营会把估算数当成真成本）。只做展示，不参与任何定价计算。
  const hotelCostPerNightCny = selectedRoomType?.costPriceCny ?? null;
  const transferCostById = useMemo(
    () => new Map(transfers.map((t) => [t.id, t.costPriceCny ?? null])),
    [transfers],
  );
  const visaCostById = useMemo(() => new Map(visas.map((v) => [v.id, v.costPriceCny ?? null])), [visas]);
  const groundCostParts = useMemo(() => {
    const parts: Array<{ label: string; amount: number | null }> = [];
    if (hasHotelItem) {
      parts.push({
        label: `0.5间×${nightsForPricing}晚 房型成本`,
        amount: hotelCostPerNightCny != null ? Math.round(0.5 * hotelCostPerNightCny * nightsForPricing) : null,
      });
    }
    const transferRows = items.filter((i) => i.kind === 'TRANSFER');
    if (transferRows.length > 0) {
      let sum = 0;
      let known = true;
      for (const row of transferRows) {
        const cost = row.transferId ? transferCostById.get(row.transferId) : undefined;
        if (cost == null) { known = false; break; }
        sum += cost * (row.qty ?? 0);
      }
      parts.push({ label: `接送成本×${transferTripsCount}趟`, amount: known ? Math.round(sum) : null });
    }
    const visaRows = items.filter((i) => i.kind === 'VISA');
    if (visaRows.length > 0) {
      let sum = 0;
      let known = true;
      for (const row of visaRows) {
        // 按 1 人计入（忽略 qty），与上面卖价口径 visaPerPax 一致。
        const cost = row.visaId ? visaCostById.get(row.visaId) : undefined;
        if (cost == null) { known = false; break; }
        sum += cost;
      }
      parts.push({ label: '签证成本', amount: known ? Math.round(sum) : null });
    }
    return parts;
  }, [hasHotelItem, nightsForPricing, hotelCostPerNightCny, items, transferCostById, transferTripsCount, visaCostById]);
  const groundCostKnownTotal = groundCostParts.reduce((s, p) => s + (p.amount ?? 0), 0);
  const groundCostAllKnown = groundCostParts.every((p) => p.amount != null);

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
  // 含 HOTEL 项必须关联房型（与后端 resolveBundleItemPrices 的 400 校验一致）：
  // 没有房型就没有权威取价源，起价会静默漏算酒店那一项（¥0 却看起来价格正常）。
  const hotelLinkValid =
    !hasHotelItem || (!!hotelRoomTypeId && hotelNights != null && hotelNights >= 1 && hotelNights <= 30);
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

  // 新增组件：价格只读来自产品，新增行不预填价（TRANSFER/VISA 须选产品才有价，见下方 SearchSelect）。
  // FLIGHT/VISA 的 qty 现为 UI 不可见的固定语义（往返 / 每人），预设成提交时会用的值（1），
  // 避免代码里留着一个界面上再也看不到、容易让人误以为还生效的旧数字（如曾经的 FLIGHT qty=2）。
  // TRANSFER 默认 2 趟（接机+送机），对应新行内「趟」提示。
  const addItem = (kind: BundleItem['kind']) => {
    const presets: Record<BundleItem['kind'], DraftBundleItem> = {
      FLIGHT: { kind: 'FLIGHT', productName: '澳门⇌岘港 经济舱', qty: 1, unitPrice: 0 },
      HOTEL: { kind: 'HOTEL', productName: '', qty: hotelNights ?? 1, unitPrice: 0 },
      TRANSFER: { kind: 'TRANSFER', productName: '', qty: 2, unitPrice: 0, transferId: null },
      VISA: { kind: 'VISA', productName: '', qty: 1, unitPrice: 0, visaId: null },
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
          <div className="grid gap-3 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className="label">适合人群</label>
              <input className="input" value={suitableFor} onChange={(e) => setSuitableFor(e.target.value)} />
            </div>
            <div>
              <label className="label">排序值（选填）</label>
              <NumberInput
                className="input"
                placeholder="留空排最后"
                value={sortOrder}
                onChange={(n) => setSortOrder(n)}
                integerOnly
              />
              <p className="mt-1 text-[11px] text-ink-muted">数字小的排前面</p>
            </div>
          </div>
          {/* 关联酒店房型 / 住宿晚数：不再单独占一块表单，控件已移进下方「套餐内容」里的首个 HOTEL 行
              （SearchSelect 搜索房型 + 行内可编辑晚数），避免同一件事有两个入口。state 仍在这里（hotelRoomTypeId /
              hotelNights），只是渲染搬到了行里。 */}
          <div className="grid gap-3 md:grid-cols-3">
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
            {/* 结算价日历取价键：档次 + 晚数都选了，代理下该套餐单才按去程出发日期自动取每人结算价 */}
            <div>
              <label className="label">结算价档次（可选）</label>
              <select
                className="input"
                value={settlementTier}
                onChange={(e) => setSettlementTier((e.target.value as SettlementTier) || '')}
              >
                <option value="">不走日历</option>
                {(Object.keys(SETTLEMENT_TIER_LABELS) as SettlementTier[]).map((t) => (
                  <option key={t} value={t}>
                    {SETTLEMENT_TIER_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">结算价晚数（可选）</label>
              <NumberInput
                className="input"
                placeholder="不走日历"
                value={settlementNights}
                onChange={(n) => setSettlementNights(n)}
                integerOnly
              />
              <p className="mt-1 text-[11px] text-ink-muted">
                档次 + 晚数都选，代理下单按去程日期在「结算价日历」自动取每人价；任一留空 = 不走日历。
              </p>
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
                placeholder="留空 = 跟随航班（按绑定航班的升舱差价）"
                value={businessUpgrade}
                onChange={(n) => setBusinessUpgrade(n)}
              />
              <p className="mt-0.5 text-[11px] text-ink-muted">
                留空 = 跟随航班（取绑定航班的每程升舱差价，一处配置随航班浮动）；填数值 = 本套餐固定覆盖（填 0 = 不提供升舱）。
              </p>
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
            <div>
              <label className="label">每人操作费（¥/人，计入起价，下单按占座人头收）</label>
              <NumberInput
                min={0}
                max={100000}
                className="input"
                placeholder="留空 = 用默认 ¥20"
                value={operationFee}
                onChange={(n) => setOperationFee(n)}
                integerOnly
              />
              <p className="mt-1 text-xs text-ink-muted">
                卖价侧、随折扣一并打折；婴儿不收。与财务成本口径的按单操作费无关。
              </p>
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
                const isFirstHotelRow = it.kind === 'HOTEL' && idx === firstHotelIdx;
                // 组件价格只读、来自产品：TRANSFER/VISA 挑产品定价，HOTEL 首行用房型整间夜价，FLIGHT 恒自动。
                const unitPriceReadOnly =
                  it.kind === 'HOTEL'
                    ? hotelNightlyPriceCny
                    : it.kind === 'TRANSFER'
                      ? (it.transferId ? transferPriceById.get(it.transferId) : undefined) ?? 0
                      : it.kind === 'VISA'
                        ? (it.visaId ? visaPriceById.get(it.visaId) : undefined) ?? 0
                        : 0;
                // VISA 按 1 人计入起价（qty 不影响单价，与后端 originalPerPaxCny 口径一致）；其余按 qty × 单价。
                const subtotal = it.kind === 'VISA' ? unitPriceReadOnly : (it.qty ?? 0) * unitPriceReadOnly;
                // 展示专用：酒店组件按双人拼房半间计价展示（unitPriceReadOnly/subtotal 仍是整间口径，
                // 用于其它计算不受影响）——只有这两个 display* 变量把半间数字渲染给运营看，
                // 与起价拆解的「酒店 0.5间×N晚」、订单实际定价的 0.5×整间口径保持一致。
                const displayUnitPrice = it.kind === 'HOTEL' ? Math.round(0.5 * unitPriceReadOnly) : unitPriceReadOnly;
                const displaySubtotal =
                  it.kind === 'HOTEL' ? Math.round(0.5 * unitPriceReadOnly * (it.qty ?? 0)) : subtotal;
                return (
                  <div key={idx}>
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-canvas p-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_LABEL[it.kind].color}`}>
                      {KIND_LABEL[it.kind].label}
                    </span>

                    {/* 名称/选择列：HOTEL 首行 / TRANSFER / VISA 用可搜索下拉；FLIGHT、HOTEL 非首行沿用文本输入。 */}
                    {isFirstHotelRow ? (
                      <SearchSelect
                        className="flex-1"
                        options={roomTypeSelectOptions}
                        value={hotelRoomTypeId || null}
                        placeholder="搜索酒店 · 房型…"
                        onChange={(id) => {
                          const rt = roomTypeOptions.find((o) => o.id === id) ?? null;
                          setHotelRoomTypeId(id);
                          setItems((prev) =>
                            prev.map((row, i) => (i === idx ? { ...row, productName: rt?.label ?? row.productName } : row)),
                          );
                        }}
                      />
                    ) : it.kind === 'TRANSFER' ? (
                      <SearchSelect
                        className="flex-1"
                        options={transferSelectOptions}
                        value={it.transferId ?? null}
                        placeholder="搜索接送产品…"
                        onChange={(id) => {
                          const t = transfers.find((x) => x.id === id) ?? null;
                          const next = [...items];
                          next[idx] = { ...it, transferId: t?.id ?? null, productName: t?.name ?? '' };
                          setItems(next);
                        }}
                      />
                    ) : it.kind === 'VISA' ? (
                      <SearchSelect
                        className="flex-1"
                        options={visaSelectOptions}
                        value={it.visaId ?? null}
                        placeholder="搜索签证产品…"
                        onChange={(id) => {
                          const v = visas.find((x) => x.id === id) ?? null;
                          const next = [...items];
                          next[idx] = { ...it, visaId: v?.id ?? null, productName: v ? `${v.country} · ${v.type}` : '' };
                          setItems(next);
                        }}
                      />
                    ) : (
                      <input
                        className="input flex-1 text-xs"
                        value={it.productName}
                        onChange={(e) => {
                          const next = [...items];
                          next[idx] = { ...it, productName: e.target.value };
                          setItems(next);
                        }}
                        placeholder={it.kind === 'HOTEL' ? '房型/描述（该行不参与自动定价）' : undefined}
                      />
                    )}

                    {/* 数量/标签列：FLIGHT=静态「往返」、VISA=静态「/人」（qty 语义混乱的两项去掉输入框）；
                        HOTEL 首行 = 住宿晚数（可编辑，与 setNights 同一状态源）；TRANSFER = 趟数（可编辑，行内标「趟」）；
                        HOTEL 非首行 = 沿用原可编辑 qty（历史行为，不新增定价语义）。 */}
                    {it.kind === 'FLIGHT' ? (
                      <span className="w-16 shrink-0 rounded-md bg-slate-100 px-2 py-1 text-center text-xs text-ink-muted">往返</span>
                    ) : it.kind === 'VISA' ? (
                      <span className="w-16 shrink-0 rounded-md bg-slate-100 px-2 py-1 text-center text-xs text-ink-muted">/人</span>
                    ) : isFirstHotelRow ? (
                      <NumberInput
                        min={1}
                        max={30}
                        className="input w-16 text-xs"
                        value={hotelNights}
                        onChange={setNights}
                        integerOnly
                      />
                    ) : it.kind === 'TRANSFER' ? (
                      <div className="flex w-20 shrink-0 items-center gap-1">
                        <NumberInput
                          min={1}
                          className="input w-12 text-xs"
                          value={it.qty}
                          onChange={(n) => {
                            const next = [...items];
                            next[idx] = { ...it, qty: n };
                            setItems(next);
                          }}
                          integerOnly
                        />
                        <span className="text-xs text-ink-muted">趟</span>
                      </div>
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
                      // 只读价格：来自产品（HOTEL=半间夜价·拼房 / TRANSFER=整车/趟 / VISA=每人价），运营不可手改。
                      // 酒店按双人拼房半间展示（displayUnitPrice/displaySubtotal 已折半）——与起价公式、
                      // 订单实际定价的 0.5×整间口径一致；提交时仍用整间口径的 unitPriceReadOnly，不受影响。
                      <span className="input flex w-24 flex-col items-end justify-center bg-canvas text-xs text-ink-muted nums leading-tight">
                        <span>¥{displayUnitPrice.toLocaleString()}</span>
                        <span className="text-[10px] text-ink-muted">
                          {it.kind === 'HOTEL' ? '/晚·半间(拼房)' : it.kind === 'TRANSFER' ? '/趟·整车' : '/人'}
                        </span>
                      </span>
                    )}
                    <span className="text-xs text-ink-muted w-20 text-right nums">
                      {it.kind === 'FLIGHT' ? '实时' : `¥${displaySubtotal.toLocaleString()}`}
                    </span>
                    <button
                      type="button"
                      className="text-xs text-ink-muted hover:text-rose-600"
                      onClick={() => setItems(items.filter((_, i) => i !== idx))}
                    >
                      ×
                    </button>
                  </div>
                  {/* 酒店行已按半间展示（上面 displayUnitPrice/displaySubtotal），这里补一句说明半间口径的来由，
                      并指向单人独住时该用的加项——避免运营看到「半间」误以为漏收单人差价。 */}
                  {isFirstHotelRow && hotelNightlyPriceCny > 0 && (
                    <p className="pl-1 text-[11px] text-ink-muted">
                      酒店按双人拼房半间计价；单人独住请加「单房差」
                    </p>
                  )}
                  </div>
                );
              })}
            </div>
            {hasHotelItem && !hotelRoomTypeId && (
              <p className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                ⚠️ 套餐含酒店组件时必须在上方酒店行搜索并关联一个房型，否则起价会漏算酒店（提交会被拦截）。
              </p>
            )}
            {nightsHint && (
              <p className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                ⚠️ 套餐名里写的「{nameNights} 晚」与住宿晚数（{hotelNights} 晚）不一致，请确认。
              </p>
            )}
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
              💡 组件价格只读、来自产品：酒店在行内搜索选择房型，数量即住宿晚数（房控按此计入占房）；接送按整车计价，数量=趟数（接机+送机=2
              趟，只接机填 1）；签证按 1 人计入起价，下单按实际出行人数收；机票已含在起价里，随出发日实时浮动，不用填价。
            </p>
            {transfers.length === 0 && items.some((it) => it.kind === 'TRANSFER') && (
              <p className="mt-1 text-xs text-amber-700">⚠️ 暂无在售接送产品，请先到 产品管理 › 地面服务 里添加。</p>
            )}
            {visas.length === 0 && items.some((it) => it.kind === 'VISA') && (
              <p className="mt-1 text-xs text-amber-700">⚠️ 暂无在售签证产品，请先到 产品管理 › 签证 里添加。</p>
            )}
            {roomTypeOptions.length === 0 && hasHotelItem && (
              <p className="mt-1 text-xs text-amber-700">⚠️ 暂无可选房型，请先到 产品管理 › 酒店 里添加酒店/房型。</p>
            )}
            {/* 0702 反馈 5d：地面成本估算（仅内部）—— 与上面「起价/人」卖价拆解分开展示，用虚线框 + 「仅内部」
                标签区隔，避免运营把两套数字混着看。未录成本的组件按「未录」显示，不拿挂牌价打折估算替代。 */}
            {groundCostParts.length > 0 && (
              <p className="mt-1.5 rounded-md border border-dashed border-slate-300 bg-slate-50 px-2 py-1 text-[11px] leading-relaxed text-ink-muted">
                <span className="mr-1 rounded bg-slate-200 px-1 py-0.5 text-[10px] font-medium text-ink-soft">仅内部</span>
                地面成本估算：
                {groundCostParts
                  .map((p) => `${p.label} ${p.amount != null ? `¥${p.amount.toLocaleString()}` : '未录'}`)
                  .join(' + ')}
                {' '}= ¥{groundCostKnownTotal.toLocaleString()}
                {!groundCostAllKnown && '（未录成本的组件按未录显示，不估算）'}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-slate-100 bg-canvas p-3 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-soft">
                起价 / 人<span className="ml-1 text-xs text-ink-muted">(1 人·半间房拼房口径)</span>
              </span>
              <span className="font-medium text-ink nums">¥{originalPerPax.toLocaleString()}</span>
            </div>
            {originalPerPaxBreakdown.length > 0 && (
              // 起价拆解：每项都是同一套变量算出（见上方 originalPerPaxBreakdown），逐项相加 = 起价，
              // 避免运营把机票/酒店/升舱几项数字混在一起猜（如把 1400=经济舱700×2 误读成升舱默认）。
              <p className="text-[11px] leading-relaxed text-ink-muted nums">
                = {originalPerPaxBreakdown.map((row) => `${row.label} ¥${row.amount.toLocaleString()}`).join(' + ')} /人
              </p>
            )}
            {flightRefLoading && (
              <p className="text-[11px] text-ink-muted">机票参考价计算中…</p>
            )}
            {flightRefError && !flightRefLoading && (
              <p className="text-[11px] text-amber-700">
                ⚠️ 机票参考价获取失败，起价里的机票项可能不准，请稍后重试或检查网络。
              </p>
            )}
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
              <strong>出发日实时机票</strong>浮动 ×(1−{pct}%)，前台买家看到「起价 ¥X/人 → 省 {pct}%」。
            </p>
            {pct > 0 && (
              <div className="text-right text-xs text-emerald-700">
                整个全包价省 {pct}%
              </div>
            )}
            {!valid && (
              <p className="text-xs text-rose-600">
                ⚠️ 请填写套餐名 + 至少 1 个产品 + 套餐价 &gt; 0 + 酒店/接送/签证组件都已选产品
                {hasHotelItem && !hotelRoomTypeId && '（酒店行还没关联房型）'}
              </p>
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
                    // FLIGHT/VISA 的 qty 在服务端不参与定价（FLIGHT 恒 0 元，VISA 按 1 人计入起价），
                    // UI 上也不再暴露可编辑输入 —— 提交时强制写 1，不管 state 里是否还留着编辑前/旧数据的值
                    // （如历史套餐里 FLIGHT qty=2 的遗留数据，编辑保存时借此机会一并规范化）。
                    const qty = it.kind === 'FLIGHT' || it.kind === 'VISA' ? 1 : Math.max(1, it.qty ?? 1);
                    return {
                      kind: it.kind,
                      productName: it.productName,
                      qty,
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
                  // 管理端可编辑排序值：留空 = 排最后
                  sortOrder,
                  hotelRoomTypeId: hotelRoomTypeId || null,
                  // 住宿晚数唯一真源：含 HOTEL 项即提交晚数（与首个 HOTEL 项 qty 一致），与是否关联房型无关。
                  hotelNights: hasHotelItem ? hotelNights ?? 1 : null,
                  singleSupplementCnyPerNight: singleSupplement,
                  businessUpgradeCnyPerLeg: businessUpgrade,
                  childSeatDiscountCnyPerPerson: childSeatDiscount,
                  selfVisaDeductCny: selfVisaDeduct,
                  // 留空按默认 ¥20 显式落数值：null 在更新路径= 「不改」，改回默认就改不动。
                  operationFeeCny: operationFee ?? 20,
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
                  // 结算价日历取价键：档次 + 晚数任一留空 = 不走日历（都置 null）；都填了才纳入日历取价。
                  settlementTier: settlementTier && settlementNights != null ? settlementTier : null,
                  settlementNights: settlementTier && settlementNights != null ? settlementNights : null,
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

function EditHotelForm({ hotel, onCancel, onSave }: { hotel: MockHotelWithCost; onCancel: () => void; onSave: (h: MockHotelWithCost) => void }) {
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
  hotel: MockHotelWithCost;
  title: string;
  submitLabel: string;
  onCancel: () => void;
  onSave: (h: MockHotelWithCost) => void;
}) {
  const [name, setName] = useState(hotel.name);
  const [nameEn, setNameEn] = useState(hotel.nameEn);
  const [cityCode, setCityCode] = useState(hotel.cityCode || 'DAD');
  const [area, setArea] = useState(hotel.area);
  const [address, setAddress] = useState(hotel.address ?? '');
  const [stars, setStars] = useState<3 | 4 | 5>(hotel.stars);
  // 国际五星：与 stars 联动的独立标记（stars 仍是纯 1..5 整数语义，见 MockHotelWithCost 注释）。
  const [intlFiveStar, setIntlFiveStar] = useState(hotel.intlFiveStar ?? false);
  // 指定酒店加价（CNY/人）：套餐录单点名住本酒店时按占座人数加收；0 = 指定不加价。
  const [designationSurcharge, setDesignationSurcharge] = useState<number | null>(
    hotel.designationSurchargeCnyPerPerson ?? 0,
  );
  const [basePrice, setBasePrice] = useState<number | null>(hotel.basePrice);
  const [emoji, setEmoji] = useState(hotel.emoji);
  const [highlight, setHighlight] = useState(hotel.highlight);
  // 图片：优先 photos[]，回退单张 photo；保证至少 1 行可填
  const [photos, setPhotos] = useState<string[]>(
    hotel.photos && hotel.photos.length > 0 ? hotel.photos : hotel.photo ? [hotel.photo] : [''],
  );
  const [amenities, setAmenities] = useState<string[]>(hotel.amenities);
  const [roomTypes, setRoomTypes] = useState<RoomTypeWithCost[]>(
    hotel.roomTypes.length > 0
      ? hotel.roomTypes
      : [{ name: '', priceMult: 1, sleeps: 2, bedType: '', maxAdults: 2, maxChildren: 1, costPriceCny: null }],
  );
  const [saved, setSaved] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPhotos = photos.map((p) => p.trim()).filter(Boolean);
    const cleanRooms = roomTypes
      .map((rt) => ({ ...rt, name: rt.name.trim(), bedType: rt.bedType.trim() }))
      .filter((rt) => rt.name);
    const updated: MockHotelWithCost = {
      ...hotel,
      name: name.trim(),
      nameEn: nameEn.trim(),
      cityCode,
      area: area.trim(),
      address: address.trim(),
      stars,
      intlFiveStar,
      designationSurchargeCnyPerPerson: Math.max(0, Math.trunc(designationSurcharge ?? 0)),
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
            {/* 国际五星与五星共用 stars=5，靠 intlFiveStar 标记区分；下拉呈现为独立第四档 */}
            <select
              className="input"
              value={stars === 5 && intlFiveStar ? 'intl5' : String(stars)}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'intl5') { setStars(5); setIntlFiveStar(true); }
                else { setStars(Number(v) as 3 | 4 | 5); setIntlFiveStar(false); }
              }}
            >
              <option value="3">三星</option>
              <option value="4">四星</option>
              <option value="5">五星</option>
              <option value="intl5">国际五星</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label text-xs">详细地址</label>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="如 越南岘港市 Vo Nguyen Giap 路 5 号" />
          </div>
          <div>
            {/* 0702 反馈 5c：与「成本价（仅内部）」并列时容易混——明确标成前台展示价。 */}
            <label className="label text-xs">每晚起价（前台展示价）</label>
            <NumberInput min={0} className="input" value={basePrice} onChange={(n) => setBasePrice(n)} />
          </div>
          <div>
            {/* 0805：套餐按星级随机报价，客人点名住本酒店时按占座人数加收的每人差价（各店各配）。 */}
            <label className="label text-xs">指定酒店加价（¥/人，0 = 不加价）</label>
            <NumberInput min={0} className="input" value={designationSurcharge} onChange={(n) => setDesignationSurcharge(n)} />
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

/** 房型管理：可增删行，每行 房型名 / 床型 / 人数 / 每晚价 / 价格系数 / 成本价（仅内部） */
function RoomTypesEditor({ roomTypes, onChange }: { roomTypes: RoomTypeWithCost[]; onChange: (v: RoomTypeWithCost[]) => void }) {
  const setAt = (idx: number, patch: Partial<RoomTypeWithCost>) =>
    onChange(roomTypes.map((rt, i) => (i === idx ? { ...rt, ...patch } : rt)));
  const removeAt = (idx: number) => onChange(roomTypes.filter((_, i) => i !== idx));
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="label text-xs !mb-0">房型管理</label>
        <button
          type="button"
          className="text-xs font-medium text-brand hover:text-brand-dark"
          onClick={() => onChange([...roomTypes, { name: '', priceMult: 1, sleeps: 2, bedType: '', maxAdults: 2, maxChildren: 1, costPriceCny: null }])}
        >
          + 添加房型
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {roomTypes.map((rt, idx) => (
          // 0702 反馈 5b：新增「成本价」列，16 列的既有网格（tailwind.config.js 里专为这行配的）放不下，
          // 用 arbitrary value 直接扩到 18 列，不改 tailwind 配置（不在本次改动的文件白名单里）。
          <div key={idx} className="grid grid-cols-2 items-end gap-2 rounded-lg border border-slate-200 bg-canvas p-2 md:grid-cols-[repeat(18,minmax(0,1fr))]">
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
            <div className="md:col-span-2">
              <label className="label text-xs">成本价（¥/晚，仅内部）</label>
              <NumberInput
                min={0}
                className="input"
                placeholder="未录"
                value={rt.costPriceCny ?? null}
                onChange={(n) => setAt(idx, { costPriceCny: n })}
              />
            </div>
            <div className="md:col-span-2 flex items-center justify-end pb-1">
              <button type="button" className="text-xs text-ink-muted hover:text-rose-600" onClick={() => removeAt(idx)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1 text-xs text-ink-muted">每晚价 = 酒店每晚起价 × 价格系数（如标准房 1.0、海景房 1.15）。成本价仅内部核算用，前台不展示。</p>
    </div>
  );
}

/** 新增地面服务：复用统一编辑器，预填一份合理空白模板（弹窗内填好再 POST）。 */
function NewTransferForm({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (t: MockTransferWithCost) => void }) {
  const blank: MockTransferWithCost = {
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
    costPriceCny: null,
  };
  return (
    <TransferEditorForm transfer={blank} title="新增地面服务" submitLabel="添加" onCancel={onCancel} onSave={onSubmit} />
  );
}

function EditTransferForm({ transfer, onCancel, onSave }: { transfer: MockTransferWithCost; onCancel: () => void; onSave: (t: MockTransferWithCost) => void }) {
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
  transfer: MockTransferWithCost;
  title: string;
  submitLabel: string;
  onCancel: () => void;
  onSave: (t: MockTransferWithCost) => void;
}) {
  const [form, setForm] = useState({ ...transfer });
  const [basePrice, setBasePrice] = useState<number | null>(transfer.basePrice);
  const [capacity, setCapacity] = useState<number | null>(transfer.capacity);
  const [costPrice, setCostPrice] = useState<number | null>(transfer.costPriceCny ?? null);
  const [featuresText, setFeaturesText] = useState(transfer.features.join(', '));
  const [saved, setSaved] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const updated: MockTransferWithCost = {
      ...form,
      basePrice: basePrice ?? 0,
      capacity: capacity ?? 1,
      costPriceCny: costPrice,
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
          {/* 0702 反馈 5c：与「成本价（仅内部）」并列时容易混——明确标成前台展示价。 */}
          <label className="label text-xs">起步价（前台展示价）</label>
          <NumberInput min={0} className="input" value={basePrice} onChange={(n) => setBasePrice(n)} />
        </div>
        <div className="md:col-span-2">
          <label className="label text-xs">车型描述</label>
          <input className="input" value={form.vehicleType} onChange={(e) => setForm({ ...form, vehicleType: e.target.value })} />
        </div>
        <div>
          {/* 0702 反馈 4：hint 曾停在旧上限 20，与后端 schema max 30 不一致，运营按 hint 会误以为填不了 25+ 人的车型。 */}
          <label className="label text-xs">最大乘客数（≤30）</label>
          <NumberInput min={1} max={30} className="input" value={capacity} onChange={(n) => setCapacity(n)} integerOnly />
        </div>
        <div>
          <label className="label text-xs">成本价（¥，仅内部，前台不展示）</label>
          <NumberInput min={0} className="input" placeholder="未录" value={costPrice} onChange={(n) => setCostPrice(n)} />
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
  const [costPrice, setCostPrice] = useState<number | null>(visa.costPriceCny ?? null);
  // 签发方式 / 入境次数（结构化分类，选填）：留空 = 未设置
  const [issuanceMethod, setIssuanceMethod] = useState<VisaIssuanceMethod | null>(visa.issuanceMethod ?? null);
  const [entryType, setEntryType] = useState<VisaEntryType | null>(visa.entryType ?? null);
  // 签证公司/代办渠道名（选填，仅内部，财务对账用——核对某笔签证金额属于哪家供应商的账单）
  const [supplier, setSupplier] = useState(visa.supplier ?? '');
  const [docsText, setDocsText] = useState(visa.requiredDocs.join(', '));
  // 加急档位表（零工/一工/二工…）：各档自己的出签工作日 + 加价。空表 = 不提供分档加急。
  // 编辑态里工作日/加价允许暂时为空（null），保存时按 0 兜底 —— 与本表单其它数字字段同款处理。
  const [tiers, setTiers] = useState<Array<{ label: string; workDays: number | null; surchargeCny: number | null }>>(
    () => (visa.expressTiers ?? []).map((t) => ({ ...t })),
  );
  const [tierError, setTierError] = useState('');
  const [saved, setSaved] = useState(false);

  // 不可变更新：绝不就地改数组元素（React 依赖引用变化重渲染）。
  const patchTier = (idx: number, patch: Partial<{ label: string; workDays: number | null; surchargeCny: number | null }>) =>
    setTiers((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  const removeTier = (idx: number) => setTiers((prev) => prev.filter((_, i) => i !== idx));
  const addTier = () =>
    setTiers((prev) => (prev.length >= VISA_EXPRESS_TIER_MAX ? prev : [...prev, { label: '', workDays: 1, surchargeCny: 0 }]));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 档位校验（与后端 zod 同口径，提前在前端拦一遍给出可读提示）：
    // 档名是定价查表的键 —— 空档名/重名会让「这一档到底多少钱」不确定，一律不放行。
    const normalizedTiers: VisaExpressTier[] = tiers.map((t) => ({
      label: t.label.trim(),
      workDays: Math.max(0, Math.trunc(t.workDays ?? 0)),
      surchargeCny: Math.max(0, t.surchargeCny ?? 0),
    }));
    if (normalizedTiers.some((t) => !t.label)) {
      setTierError('每个加急档都要填档名（如「一工」）');
      return;
    }
    if (new Set(normalizedTiers.map((t) => t.label)).size !== normalizedTiers.length) {
      setTierError('加急档名不能重复');
      return;
    }
    if (normalizedTiers.length > VISA_EXPRESS_TIER_MAX) {
      setTierError(`加急档位最多 ${VISA_EXPRESS_TIER_MAX} 档`);
      return;
    }
    setTierError('');
    const updated: MockVisaWithStayDays = {
      ...form,
      basePrice: basePrice ?? 0,
      expressSurcharge: expressSurcharge ?? 0,
      processingDays: processingDays ?? 1,
      validityMonths: validityMonths ?? 1,
      highlight: form.highlight || undefined,
      requiredDocs: docsText.split(',').map(s => s.trim()).filter(Boolean),
      stayDays: stayDays ?? undefined,
      costPriceCny: costPrice,
      issuanceMethod,
      entryType,
      supplier: supplier.trim() || null,
      expressTiers: normalizedTiers,
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
          {/* 0702 反馈 4：maxLength 曾放宽到 3，实际 ISO 3166-1 alpha-2 只有 2 位，
              后端 destinationCountry: z.string().length(2) 对 3 位一律 400——运营填了却存不进去。 */}
          <label className="label text-xs">国家代码（2 位，如 VN）</label>
          <input
            className="input"
            value={form.countryCode}
            onChange={(e) => setForm({ ...form, countryCode: e.target.value.toUpperCase() })}
            maxLength={2}
            placeholder="VN"
          />
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
          {/* 0702 反馈 5c：与「成本价（仅内部）」并列时容易混——明确标成前台展示价。 */}
          <label className="label text-xs">办理费（前台展示价）</label>
          <NumberInput min={0} className="input" value={basePrice} onChange={(n) => setBasePrice(n)} />
        </div>
        <div>
          <label className="label text-xs">加急附加费 (¥)</label>
          <NumberInput min={0} className="input" value={expressSurcharge} onChange={(n) => setExpressSurcharge(n)} />
          <p className="mt-1 text-[11px] text-ink-muted">未配下方「加急档位」时按这一个价收</p>
        </div>
        <div>
          <label className="label text-xs">成本价（¥，仅内部，前台不展示）</label>
          <NumberInput min={0} className="input" placeholder="未录" value={costPrice} onChange={(n) => setCostPrice(n)} />
        </div>
        <div>
          <label className="label text-xs">签证公司（选填，仅内部，财务对账用）</label>
          <input
            className="input"
            placeholder="如 XX签证代办"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          />
        </div>
        <div>
          <label className="label text-xs">出签天数（工作日）</label>
          <NumberInput min={1} max={60} className="input" value={processingDays} onChange={(n) => setProcessingDays(n)} integerOnly />
        </div>
        <div>
          <label className="label text-xs">有效期 (月)</label>
          <NumberInput min={1} max={120} className="input" value={validityMonths} onChange={(n) => setValidityMonths(n)} integerOnly />
          <p className="mt-1 text-[11px] text-ink-muted">落地签/短签为出签当日生效，可留空，按「单次最多停留(天)」掌握</p>
        </div>
        <div>
          <label className="label text-xs">单次最多停留（天，选填）</label>
          <NumberInput min={1} max={365} className="input" value={stayDays} onChange={(n) => setStayDays(n)} integerOnly placeholder="不限则留空" />
        </div>
        <div>
          <label className="label text-xs">签发方式（选填）</label>
          <select
            className="input"
            value={issuanceMethod ?? ''}
            onChange={(e) => setIssuanceMethod(e.target.value ? (e.target.value as VisaIssuanceMethod) : null)}
          >
            <option value="">未设置</option>
            <option value="E_VISA">电子签</option>
            <option value="STICKER">贴纸签</option>
            <option value="ARRIVAL">落地签</option>
            <option value="OTHER">其他</option>
          </select>
        </div>
        <div>
          <label className="label text-xs">入境次数（选填）</label>
          <select
            className="input"
            value={entryType ?? ''}
            onChange={(e) => setEntryType(e.target.value ? (e.target.value as VisaEntryType) : null)}
          >
            <option value="">未设置</option>
            <option value="SINGLE">单次</option>
            <option value="MULTIPLE">多次</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="label text-xs">卖点（如"最热销"）</label>
          <input className="input" value={form.highlight} onChange={(e) => setForm({ ...form, highlight: e.target.value })} />
        </div>
        <div className="md:col-span-3">
          <label className="label text-xs">所需材料（逗号分隔）</label>
          <input className="input" value={docsText} onChange={(e) => setDocsText(e.target.value)} placeholder="护照首页扫描件, 2寸白底照片" />
        </div>

        {/* 加急档位（零工/一工/二工…）：各档自己的出签工作日 + 加价，运营自行增删。
            配了档位后录单会出现「加急档位」下拉；一档没配 = 沿用上面的单值「加急附加费」。 */}
        <fieldset className="md:col-span-3 rounded-lg border border-brand-200 bg-white/70 p-3">
          <legend className="px-1 text-xs font-medium text-ink">加急档位（选填）</legend>
          <p className="mb-2 text-[11px] text-ink-muted">
            按加急等级分别配「出签工作日 + 加价」（如 零工 / 一工 / 二工）。档名是录单选档的依据，不能重复。
            一档都不配 = 不提供分档加急，仍按上面的单值「加急附加费」收。
          </p>
          {tiers.length === 0 ? (
            <p className="text-xs text-ink-muted">尚未配置加急档位</p>
          ) : (
            <div className="grid gap-2">
              {tiers.map((t, idx) => (
                <div key={idx} className="grid grid-cols-[1.2fr_1fr_1fr_auto] items-end gap-2">
                  <div>
                    <label className="label text-[11px]">档名 *</label>
                    <input
                      className="input"
                      value={t.label}
                      maxLength={20}
                      placeholder="如 一工"
                      onChange={(e) => patchTier(idx, { label: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="label text-[11px]">出签工作日</label>
                    <NumberInput
                      min={0}
                      max={365}
                      integerOnly
                      className="input"
                      value={t.workDays}
                      onChange={(n) => patchTier(idx, { workDays: n })}
                    />
                  </div>
                  <div>
                    <label className="label text-[11px]">加价 (¥/份)</label>
                    <NumberInput
                      min={0}
                      className="input"
                      value={t.surchargeCny}
                      onChange={(n) => patchTier(idx, { surchargeCny: n })}
                    />
                  </div>
                  <button type="button" className="btn-ghost mb-1 px-2 py-1 text-xs text-rose-600" onClick={() => removeTier(idx)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
          {tierError && <p className="mt-2 text-xs text-rose-600">{tierError}</p>}
          <button
            type="button"
            className="btn-secondary mt-2 px-3 py-1 text-xs"
            onClick={addTier}
            disabled={tiers.length >= VISA_EXPRESS_TIER_MAX}
          >
            + 添加档位{tiers.length >= VISA_EXPRESS_TIER_MAX ? `（最多 ${VISA_EXPRESS_TIER_MAX} 档）` : ''}
          </button>
        </fieldset>

        {saved && <div className="md:col-span-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">保存中…</div>}

        <div className="md:col-span-3 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary">{submitLabel}</button>
        </div>
      </form>
    </section>
  );
}
