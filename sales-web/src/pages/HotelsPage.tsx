import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type MockHotel } from '../lib/mockData';
import { api, type Hotel } from '../lib/api';
import { useCart } from '../stores/cart';
import { Icon } from '../components/Icon';

/** 星级 → 实心星图标行（取代 '★'.repeat 文本，统一图标观感） */
function StarRow({ count, className }: { count: number; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className ?? ''}`}>
      {Array.from({ length: count }).map((_, i) => (
        <Icon key={i} name="star" className="h-3 w-3" />
      ))}
    </span>
  );
}

function hotelApiToMock(h: Hotel): MockHotel {
  return {
    id: h.id, name: h.name, nameEn: h.nameEn ?? h.name, cityCode: h.cityCode,
    area: h.area ?? h.address, stars: (h.starRating as 3 | 4 | 5),
    basePrice: Number(h.basePrice ?? 0), rating: h.rating ? Number(h.rating) : 4.5,
    reviewCount: h.reviewCount ?? 0, emoji: h.emoji ?? '🏨',
    photo: h.photos[0] ?? '', amenities: h.amenities, highlight: h.highlight ?? '',
    roomTypes: h.roomTypes.map((rt) => ({
      name: rt.name, priceMult: rt.priceMultiplier ? Number(rt.priceMultiplier) : 1,
      sleeps: rt.capacity, bedType: rt.bedType ?? '',
    })),
  };
}

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function HotelsPage() {
  const [hotels, setHotels] = useState<MockHotel[]>([]);
  const [city, setCity] = useState('');
  const [stars, setStars] = useState<'' | '3' | '4' | '5'>('');
  const [maxPrice, setMaxPrice] = useState(4000);
  const [checkIn, setCheckIn] = useState(todayISO(3));
  const [checkOut, setCheckOut] = useState(todayISO(5));
  const [selected, setSelected] = useState<MockHotel | null>(null);
  const add = useCart((s) => s.add);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api.listHotels().then((r) => { if (!cancelled) setHotels(r.hotels.map(hotelApiToMock)); }).catch(() => {/* 静默失败 */});
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    return hotels.filter((h) => {
      if (city && h.cityCode !== city) return false;
      if (stars && h.stars !== Number(stars)) return false;
      if (h.basePrice > maxPrice) return false;
      return true;
    });
  }, [hotels, city, stars, maxPrice]);

  const nights = Math.max(
    1,
    Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000),
  );

  return (
    <div className="space-y-6">
      <section className="card">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">酒店预订</h1>
        <p className="mt-1 text-sm text-ink-soft">
          覆盖东南亚 / 中国港澳 / 全球主要城市，与航班打包可享额外折扣。下方为本月精选房型。
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-5">
          <div>
            <label className="label">目的地</label>
            <select className="input" value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="">全部（岘港 + 会安）</option>
              <option value="DAD">岘港</option>
              <option value="HOA">会安</option>
            </select>
          </div>
          <div>
            <label className="label">入住</label>
            <input type="date" className="input" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
          </div>
          <div>
            <label className="label">退房</label>
            <input type="date" className="input" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
          </div>
          <div>
            <label className="label">星级</label>
            <select className="input" value={stars} onChange={(e) => setStars(e.target.value as '' | '3' | '4' | '5')}>
              <option value="">不限</option>
              <option value="3">三星</option>
              <option value="4">四星</option>
              <option value="5">五星</option>
            </select>
          </div>
          <div>
            <label className="label">价格上限 ¥{maxPrice}</label>
            <input
              type="range"
              min={500}
              max={4000}
              step={100}
              className="w-full"
              value={maxPrice}
              onChange={(e) => setMaxPrice(Number(e.target.value))}
            />
          </div>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <p className="section-title">精选酒店</p>
          <p className="text-sm text-ink-muted">找到 {filtered.length} 家 · {nights} 晚</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((h) => (
            <article
              key={h.id}
              className="card-interactive group flex cursor-pointer flex-col overflow-hidden"
              onClick={() => setSelected(h)}
            >
              <div className="relative h-44 w-full overflow-hidden bg-slate-100">
                <img
                  src={h.photo}
                  alt={h.name}
                  className="img-zoom h-full w-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/35 to-transparent" />
                <span className="badge-sun absolute left-3 top-3 shadow-card"><StarRow count={h.stars} /></span>
                <span className="rating absolute right-3 top-3 inline-flex items-center gap-0.5 shadow-card">
                  <Icon name="star" className="h-3 w-3 text-amber-500" />
                  {h.rating}
                </span>
              </div>
              <div className="flex flex-1 flex-col p-4">
                <h3 className="font-bold text-ink">{h.name}</h3>
                <p className="text-xs text-ink-muted">{h.nameEn}</p>
                <p className="mt-1 inline-flex items-center gap-1 text-xs text-ink-soft">
                  <Icon name="mapPin" className="h-3 w-3 shrink-0" />
                  {h.area} · {h.reviewCount} 条评价
                </p>
                <p className="mt-2 line-clamp-2 text-xs italic text-ink-soft">{h.highlight}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {h.amenities.slice(0, 3).map((a) => (
                    <span key={a} className="chip">{a}</span>
                  ))}
                </div>
                <div className="mt-4 flex items-end justify-between border-t border-slate-100 pt-3">
                  <div>
                    <div className="text-xs text-ink-muted">每晚起</div>
                    <div className="flex items-baseline gap-1">
                      <span className="price text-xl">¥{h.basePrice}</span>
                    </div>
                  </div>
                  <button className="btn-deal py-1.5 text-sm">查看详情</button>
                </div>
              </div>
            </article>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="card text-ink-soft">没有符合条件的酒店，请调整筛选条件。</div>
        )}
      </section>

      {selected && (
        <HotelDetailModal
          hotel={selected}
          nights={nights}
          checkIn={checkIn}
          checkOut={checkOut}
          onClose={() => setSelected(null)}
          onAdd={(room, rooms, goCart) => {
            const unitPrice = Math.round(selected.basePrice * room.priceMult * nights) * rooms;
            add({
              kind: 'HOTEL',
              productId: `${selected.id}-${room.name}`,
              name: `${selected.name} · ${room.name} × ${rooms} 房 · ${nights} 晚`,
              description: `${selected.area} · ${'★'.repeat(selected.stars)} · ${room.bedType}`,
              emoji: selected.emoji,
              unitPrice,
              qty: 1,
              meta: { checkIn, checkOut, nights, roomType: room.name, rooms },
            });
            setSelected(null);
            if (goCart) navigate('/cart');
          }}
        />
      )}
    </div>
  );
}

function HotelDetailModal({
  hotel,
  nights,
  checkIn,
  checkOut,
  onClose,
  onAdd,
}: {
  hotel: MockHotel;
  nights: number;
  checkIn: string;
  checkOut: string;
  onClose: () => void;
  onAdd: (room: import('../lib/mockData').HotelRoomType, rooms: number, goCart: boolean) => void;
}) {
  const [selectedRoomIdx, setSelectedRoomIdx] = useState(0);
  const [rooms, setRooms] = useState(1);
  const [selectedCheckIn, setSelectedCheckIn] = useState(checkIn);
  const [selectedCheckOut, setSelectedCheckOut] = useState(checkOut);
  const room = hotel.roomTypes[selectedRoomIdx];
  const actualNights = Math.max(
    1,
    Math.round((new Date(selectedCheckOut).getTime() - new Date(selectedCheckIn).getTime()) / 86400000),
  );
  const _unused = nights; void _unused;
  const unitPrice = Math.round(hotel.basePrice * room.priceMult);
  const total = unitPrice * actualNights * rooms;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-3xl bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200/80 bg-surface/90 px-6 py-4 backdrop-blur-xl">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold tracking-tight text-ink">
            <Icon name="hotel" className="h-5 w-5 text-brand" />
            {hotel.name}
          </h2>
          <button onClick={onClose} className="text-xl text-ink-muted transition-colors hover:text-ink">×</button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="relative overflow-hidden rounded-2xl bg-slate-100">
            <img src={hotel.photo} alt={hotel.name} className="h-52 w-full object-cover" />
          </div>

          <div className="flex items-center gap-2">
            <span className="badge-sun"><StarRow count={hotel.stars} /></span>
            <span className="rating inline-flex items-center gap-0.5">
              <Icon name="star" className="h-3 w-3 text-amber-500" />
              {hotel.rating} / 5
            </span>
            <span className="text-xs text-ink-muted">{hotel.reviewCount} 条评价</span>
            <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
              · <Icon name="mapPin" className="h-3 w-3" /> {hotel.area}
            </span>
          </div>
          <p className="text-sm italic text-ink-soft">{hotel.highlight}</p>

          {/* 入住日期调整 */}
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="label text-xs">入住</label>
              <input
                type="date"
                className="input"
                value={selectedCheckIn}
                onChange={(e) => setSelectedCheckIn(e.target.value)}
              />
            </div>
            <div>
              <label className="label text-xs">退房</label>
              <input
                type="date"
                className="input"
                value={selectedCheckOut}
                min={selectedCheckIn}
                onChange={(e) => setSelectedCheckOut(e.target.value)}
              />
            </div>
            <div>
              <label className="label text-xs">房间数</label>
              <div className="flex h-10 items-center overflow-hidden rounded-xl border border-slate-200">
                <button
                  type="button"
                  className="h-full px-3 text-ink-soft transition-colors hover:bg-brand-50 disabled:text-slate-300"
                  disabled={rooms <= 1}
                  onClick={() => setRooms(rooms - 1)}
                >−</button>
                <span className="nums flex-1 text-center font-semibold text-ink">{rooms}</span>
                <button
                  type="button"
                  className="h-full px-3 text-ink-soft transition-colors hover:bg-brand-50 disabled:text-slate-300"
                  disabled={rooms >= 5}
                  onClick={() => setRooms(rooms + 1)}
                >+</button>
              </div>
            </div>
          </div>

          {/* 房型选择 */}
          <div>
            <h3 className="font-bold text-ink">选择房型（{hotel.roomTypes.length} 种）</h3>
            <div className="mt-2 space-y-2">
              {hotel.roomTypes.map((r, idx) => {
                const rPrice = Math.round(hotel.basePrice * r.priceMult);
                const selected = idx === selectedRoomIdx;
                return (
                  <button
                    key={r.name}
                    type="button"
                    onClick={() => setSelectedRoomIdx(idx)}
                    className={`w-full rounded-2xl border-2 p-3 text-left transition-all ${
                      selected ? 'border-brand bg-brand-50/60 shadow-card' : 'border-slate-200 hover:border-brand/40'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-ink">{r.name}</span>
                          {selected && <span className="badge-soft">已选</span>}
                        </div>
                        <div className="mt-0.5 text-xs text-ink-muted">
                          {r.bedType} · 可住 {r.sleeps} 人
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="price text-lg">¥{rPrice}</div>
                        <div className="text-xs text-ink-muted">每晚</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 价格汇总 */}
          <div className="rounded-2xl border border-slate-200/80 bg-canvas p-4">
            <div className="flex justify-between text-sm">
              <span className="text-ink-soft">{room.name} · ¥{unitPrice}/晚</span>
              <span className="font-semibold text-ink">¥{unitPrice}</span>
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-ink-soft">{actualNights} 晚 × {rooms} 房</span>
              <span className="font-semibold text-ink">¥{unitPrice * actualNights * rooms}</span>
            </div>
            <div className="mt-3 flex items-end justify-between border-t border-slate-200 pt-3">
              <span className="text-sm text-ink-soft">合计</span>
              <span className="price text-2xl">¥{total.toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* 底部固定 CTA 栏 */}
        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-slate-200/80 bg-surface/90 px-6 py-4 backdrop-blur-xl">
          <div className="text-sm">
            <span className="text-ink-soft">合计 </span>
            <span className="price text-xl">¥{total.toLocaleString()}</span>
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary inline-flex items-center gap-1.5" onClick={() => onAdd(room, rooms, false)}>
              <Icon name="cart" className="h-4 w-4" />加入购物车
            </button>
            <button className="btn-deal inline-flex items-center gap-1.5" onClick={() => onAdd(room, rooms, true)}>
              立即购买 <Icon name="arrowRight" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
