/**
 * 套餐展示页 — 可配置人数 + 房间数。
 *
 * 机票：动态价 × 人数（从 /flights/search 实时拉，顺带拿去/回航班号+时刻展示）
 * 酒店：每晚价 × 晚数 × 房间数（关联房型时展示 酒店名+房型，含双早 · 2人1间）
 * 签证：每人价 × 人数
 * 接送：固定价（按趟，不按人头）
 * 升级：单住补房差 / 升舱商务 仅展示（收费走线下人工）
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { type MockBundle, type BundleItem } from '../lib/mockData';
import { api, type Bundle as ApiBundle, type Hotel } from '../lib/api';
import { formatLocalTime } from '../lib/airports';
import { BED_TYPE_NOTE } from '../lib/notices';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { BenefitsStrip } from '../components/BenefitsStrip';
import { BookingNotices } from '../components/BookingNotices';
import { matchKeyword } from '../components/HomeSections';
import { useCart } from '../stores/cart';

/** MockBundle + 后端新增展示字段（升级价 / 关联房型） */
interface BundleView extends MockBundle {
  singleSupplementPerNight: number | null;
  cabinUpgradePerLeg: number | null;
  hotelRoomType: { id: string; name: string; hotelName: string } | null;
}

function bundleApiToView(b: ApiBundle): BundleView {
  const items = (b.items as BundleItem[]) ?? [];
  const groundTotal = items.filter((i) => i.kind !== 'FLIGHT').reduce((s, i) => s + i.unitPrice * i.qty, 0);
  return {
    id: b.id, name: b.name, tagline: b.tagline ?? '', emoji: b.emoji ?? '🎁',
    photo: b.photo ?? '',
    items, listPrice: groundTotal, bundlePrice: groundTotal,
    groundDiscount: Number(b.groundDiscount), flightPax: b.flightPax,
    suitableFor: b.suitableFor ?? '', active: b.isActive,
    singleSupplementPerNight:
      b.singleSupplementCnyPerNight != null ? Number(b.singleSupplementCnyPerNight) : null,
    cabinUpgradePerLeg: b.cabinUpgradeCnyPerLeg != null ? Number(b.cabinUpgradeCnyPerLeg) : null,
    hotelRoomType: b.hotelRoomType ?? null,
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

/** 去/回航段展示信息（从 /flights/search 第一条结果取） */
interface LegInfo {
  flightNumber: string;
  departureTime: string;
  arrivalTime: string;
  departureTz: string;
  arrivalTz: string;
}

/** 套餐 → 酒店匹配：优先关联房型的酒店名，退化到 HOTEL 行项名称包含酒店名 */
function matchHotelForBundle(b: BundleView, hotels: Hotel[]): Hotel | undefined {
  if (b.hotelRoomType) {
    const byRoom = hotels.find((h) => h.name === b.hotelRoomType?.hotelName);
    if (byRoom) return byRoom;
  }
  const hotelItem = b.items.find((i) => i.kind === 'HOTEL');
  if (!hotelItem) return undefined;
  return hotels.find((h) => h.name && hotelItem.productName.includes(h.name));
}

export function BundlesPage() {
  const add = useCart((s) => s.add);
  const [bundles, setBundles] = useState<BundleView[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.listBundles().then((r) => { if (!cancelled) setBundles(r.bundles.map(bundleApiToView)); }).catch(() => {/* 静默 */});
    api.listHotels().then((r) => { if (!cancelled) setHotels(r.hotels); }).catch(() => {/* 静默 */});
    return () => { cancelled = true; };
  }, []);

  const [goDate, setGoDate] = useState(todayISO(3));
  const [returnDate, setReturnDate] = useState(todayISO(7));

  // 套餐关键字搜索（名称 / 行项 / 酒店名，防抖 300ms）
  // 首页套餐卡深链 /bundles?kw=xxx → 挂载时预填搜索框，落地即过滤
  const [searchParams] = useSearchParams();
  const [keyword, setKeyword] = useState(() => searchParams.get('kw') ?? '');
  const kw = useDebouncedValue(keyword);

  // 动态机票价（单人来回）— dateRank 不展示给客户，所以不存进 state
  const [flightPrices, setFlightPrices] = useState({
    econPerPerson: 0,
    bizPerPerson: 0,
    loaded: false,
  });
  // 去/回航班号 + 时刻（套餐卡展示用；搜不到就不显示）
  const [legs, setLegs] = useState<{ go: LegInfo | null; ret: LegInfo | null }>({ go: null, ret: null });

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
      const toLeg = (r: (typeof go.results)[number] | undefined): LegInfo | null =>
        r
          ? {
              flightNumber: r.flightNumber,
              departureTime: r.departureTime,
              arrivalTime: r.arrivalTime,
              departureTz: r.departureTz,
              arrivalTz: r.arrivalTz,
            }
          : null;
      setLegs({ go: toLeg(go.results[0]), ret: toLeg(ret.results[0]) });
    } catch {
      setFlightPrices({ econPerPerson: 2860, bizPerPerson: 8660, loaded: true });
      setLegs({ go: null, ret: null });
    }
  }, [goDate, returnDate]);

  useEffect(() => { loadPrices(); }, [loadPrices]);

  // 酒店明细 modal（笔记式：照片 + 房型 + 设施）
  const [hotelModal, setHotelModal] = useState<{ hotel: Hotel; roomTypeName: string | null } | null>(null);

  const visible = bundles.filter(
    (b) =>
      b.active &&
      matchKeyword(
        kw,
        b.name,
        b.tagline,
        b.suitableFor,
        b.hotelRoomType?.hotelName,
        b.hotelRoomType?.name,
        ...b.items.map((i) => i.productName),
      ),
  );

  return (
    <div className="space-y-5">
      <section className="rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 p-6 text-white">
        <h1 className="text-2xl font-bold">岘港全包套餐</h1>
        <p className="mt-1 text-sm text-emerald-50">
          来回机票 + 酒店含早 + 接送 + 签证一价全含。可调人数和房间数，价格实时更新。
        </p>
      </section>

      <BenefitsStrip />

      <section className="card">
        <div className="grid gap-4 md:grid-cols-4">
          <div>
            <label className="label">去程日期</label>
            <input type="date" className="input" value={goDate} onChange={(e) => setGoDate(e.target.value)} />
          </div>
          <div>
            <label className="label">回程日期</label>
            <input type="date" className="input" value={returnDate} min={goDate} onChange={(e) => setReturnDate(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="bundle-keyword">搜索套餐</label>
            <input
              id="bundle-keyword"
              type="search"
              className="input"
              placeholder="如：凯悦 / 蜜月 / 商务"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
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
        {visible.length === 0 && bundles.length > 0 && (
          <div className="card text-sm text-slate-500">没有匹配"{kw}"的套餐，清空搜索框看全部。</div>
        )}
        {visible.map((b) => (
          <ConfigurableBundleCard
            key={b.id}
            bundle={b}
            flightPrices={flightPrices}
            goDate={goDate}
            returnDate={returnDate}
            legs={legs}
            hotel={matchHotelForBundle(b, hotels)}
            onShowHotel={(hotel) => setHotelModal({ hotel, roomTypeName: b.hotelRoomType?.name ?? null })}
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

      {/* 预订须知 / 扣损规则 / 值机提示 */}
      <BookingNotices />

      {hotelModal && (
        <HotelInfoModal
          hotel={hotelModal.hotel}
          roomTypeName={hotelModal.roomTypeName}
          onClose={() => setHotelModal(null)}
        />
      )}
    </div>
  );
}

// ── 可配置套餐卡 ─────────────────────────────────────────────────

function ConfigurableBundleCard({
  bundle: b,
  flightPrices,
  goDate,
  returnDate,
  legs,
  hotel,
  onShowHotel,
  onAdd,
}: {
  bundle: BundleView;
  flightPrices: { econPerPerson: number; bizPerPerson: number };
  goDate: string;
  returnDate: string;
  legs: { go: LegInfo | null; ret: LegInfo | null };
  hotel?: Hotel;
  onShowHotel: (hotel: Hotel) => void;
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
  const perPerson = pax > 0 ? Math.round(total / pax) : total;

  // 含什么 — 接送/签证按行项判断，中文客服全套餐标配
  const inclusions = [
    b.items.some((i) => i.kind === 'HOTEL') ? '🏨 酒店含双早' : null,
    b.items.some((i) => i.kind === 'TRANSFER') ? '🚐 当地接送' : null,
    b.items.some((i) => i.kind === 'VISA') ? '🛂 签证代办' : null,
    '🎧 中文客服',
  ].filter((x): x is string => x !== null);

  const hasUpgrades = b.singleSupplementPerNight != null || b.cabinUpgradePerLeg != null;

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
      <div className="p-4 md:p-5">
      <div className="flex flex-wrap items-start gap-4">
        {!b.photo && <span className="text-4xl">{b.emoji}</span>}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-slate-900">{b.name}</h3>
          </div>
          <p className="mt-0.5 text-sm text-slate-600">{b.tagline}</p>
          {/* 含什么 一眼看清 */}
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
            {inclusions.map((inc) => (
              <span key={inc} className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
                {inc}
              </span>
            ))}
          </div>
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

      {/* 去/回航班号 + 时刻（搜得到班次才显示） */}
      {(legs.go || legs.ret) && (
        <div className="mt-3 grid gap-1.5 rounded-md bg-sky-50/70 p-2.5 text-xs text-slate-700 sm:grid-cols-2">
          {legs.go && (
            <div className="flex items-center gap-1.5">
              <span className="rounded bg-sky-100 px-1.5 py-0.5 font-semibold text-sky-700">去程</span>
              <span className="font-medium">{legs.go.flightNumber}</span>
              <span>
                {goDate} {formatLocalTime(legs.go.departureTime, legs.go.departureTz)} →{' '}
                {formatLocalTime(legs.go.arrivalTime, legs.go.arrivalTz)}
              </span>
            </div>
          )}
          {legs.ret && (
            <div className="flex items-center gap-1.5">
              <span className="rounded bg-sky-100 px-1.5 py-0.5 font-semibold text-sky-700">回程</span>
              <span className="font-medium">{legs.ret.flightNumber}</span>
              <span>
                {returnDate} {formatLocalTime(legs.ret.departureTime, legs.ret.departureTz)} →{' '}
                {formatLocalTime(legs.ret.arrivalTime, legs.ret.arrivalTz)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 酒店 + 房型（含双早 · 2人1间 · 床型尽量安排） */}
      {(b.hotelRoomType || hotel) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-purple-50/70 p-2.5 text-xs text-slate-700">
          <span>
            🏨 <span className="font-medium">{b.hotelRoomType?.hotelName ?? hotel?.name}</span>
            {b.hotelRoomType?.name ? ` · ${b.hotelRoomType.name}` : ''} · 含双早 · 2 人 1 间
          </span>
          <span className="text-slate-500">（{BED_TYPE_NOTE}）</span>
          {hotel && (
            <button
              type="button"
              className="text-brand hover:text-brand-dark font-medium"
              onClick={() => onShowHotel(hotel)}
            >
              查看酒店明细 →
            </button>
          )}
        </div>
      )}

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

      {/* 可自愿付费升级（仅展示，收费走线下人工） */}
      {hasUpgrades && (
        <div className="mt-3 rounded-md border border-dashed border-indigo-300 bg-indigo-50/60 p-2.5 text-xs text-indigo-800">
          <span className="font-semibold">可选升级（自愿付费，下单后联系客服办理）：</span>{' '}
          {[
            b.singleSupplementPerNight != null
              ? `单住补房差 ¥${b.singleSupplementPerNight.toLocaleString()}/晚`
              : null,
            b.cabinUpgradePerLeg != null
              ? `升舱商务 ¥${b.cabinUpgradePerLeg.toLocaleString()}/程`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}

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
          <div className="text-right">
            {b.groundDiscount > 0 && (
              <span className="text-xs text-slate-400 line-through mr-2">¥{listTotal.toLocaleString()}</span>
            )}
            <span className="text-2xl font-bold text-red-600">¥{total.toLocaleString()}</span>
            <div className="text-xs text-slate-500">≈ ¥{perPerson.toLocaleString()} /人</div>
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

// ── 酒店明细 modal（笔记式：照片 + 房型 + 设施，只看不订）──────────

function HotelInfoModal({
  hotel,
  roomTypeName,
  onClose,
}: {
  hotel: Hotel;
  roomTypeName: string | null;
  onClose: () => void;
}) {
  const matchedRoom = roomTypeName
    ? hotel.roomTypes.find((rt) => rt.name === roomTypeName)
    : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">
            {hotel.emoji ?? '🏨'} {hotel.name}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl" aria-label="关闭">×</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {hotel.photos[0] && (
            <img
              src={hotel.photos[0]}
              alt={hotel.name}
              className="w-full h-48 object-cover rounded-md"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          )}
          {hotel.photos.length > 1 && (
            <div className="grid grid-cols-3 gap-2">
              {hotel.photos.slice(1, 4).map((p) => (
                <img
                  key={p}
                  src={p}
                  alt=""
                  loading="lazy"
                  className="h-20 w-full object-cover rounded"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">
              {'★'.repeat(hotel.starRating)}
            </span>
            {hotel.rating && (
              <span className="rounded bg-green-100 px-2 py-0.5 font-semibold text-green-700">
                {hotel.rating} / 5
              </span>
            )}
            <span className="text-slate-500">📍 {hotel.area ?? hotel.address}</span>
          </div>

          {hotel.highlight && <p className="text-sm text-slate-700 italic">{hotel.highlight}</p>}

          {/* 套餐安排的房型 */}
          <div className="rounded-md border border-purple-200 bg-purple-50/60 p-3 text-sm">
            <div className="font-semibold text-slate-900">
              本套餐房型：{roomTypeName ?? matchedRoom?.name ?? '以确认单为准'}
            </div>
            <div className="mt-1 text-xs text-slate-600">
              {matchedRoom?.bedType ? `${matchedRoom.bedType} · ` : ''}
              {matchedRoom ? `可住 ${matchedRoom.capacity} 人 · ` : ''}
              含双早 · 2 人 1 间
            </div>
            <div className="mt-1 text-xs text-slate-500">{BED_TYPE_NOTE}</div>
          </div>

          {/* 设施 */}
          {hotel.amenities.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-slate-900">酒店设施</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {hotel.amenities.map((a) => (
                  <span key={a} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {a}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button className="btn-secondary" onClick={onClose}>知道了</button>
          </div>
        </div>
      </div>
    </div>
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
// 余房档位：套餐数据没有余房口径，按"没有数据就不展示"处理（不造假数字）
