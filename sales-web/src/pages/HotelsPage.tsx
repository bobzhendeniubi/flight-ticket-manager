import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MOCK_HOTELS, type MockHotel } from '../lib/mockData';
import { useCart } from '../stores/cart';

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function HotelsPage() {
  const [city, setCity] = useState('');
  const [stars, setStars] = useState<'' | '3' | '4' | '5'>('');
  const [maxPrice, setMaxPrice] = useState(4000);
  const [checkIn, setCheckIn] = useState(todayISO(3));
  const [checkOut, setCheckOut] = useState(todayISO(5));
  const [selected, setSelected] = useState<MockHotel | null>(null);
  const add = useCart((s) => s.add);
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    return MOCK_HOTELS.filter((h) => {
      if (city && h.cityCode !== city) return false;
      if (stars && h.stars !== Number(stars)) return false;
      if (h.basePrice > maxPrice) return false;
      return true;
    });
  }, [city, stars, maxPrice]);

  const nights = Math.max(
    1,
    Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000),
  );

  return (
    <div className="space-y-6">
      <section className="card">
        <h1 className="text-2xl font-bold text-slate-900">岘港酒店预订</h1>
        <p className="mt-1 text-sm text-slate-600">
          8 家直签合作酒店，覆盖美溪海滩 / 山茶半岛 / 会安，与 QH9588/9589 航班打包享额外折扣。
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
        <p className="text-sm text-slate-500 mb-3">找到 {filtered.length} 家酒店 · {nights} 晚</p>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((h) => (
            <article key={h.id} className="card hover:shadow-md transition cursor-pointer" onClick={() => setSelected(h)}>
              <div className="flex items-start justify-between">
                <img src={h.photo} alt={h.name} className="w-full h-36 object-cover rounded-md" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                  {'★'.repeat(h.stars)}
                </span>
              </div>
              <h3 className="mt-3 font-semibold text-slate-900">{h.name}</h3>
              <p className="text-xs text-slate-400">{h.nameEn}</p>
              <p className="mt-1 text-xs text-slate-500">📍 {h.area}</p>
              <div className="mt-2 flex items-center gap-2">
                <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-semibold text-green-700">
                  {h.rating}
                </span>
                <span className="text-xs text-slate-500">{h.reviewCount} 条评价</span>
              </div>
              <p className="mt-2 text-xs text-slate-600 italic line-clamp-2">{h.highlight}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {h.amenities.slice(0, 3).map((a) => (
                  <span key={a} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {a}
                  </span>
                ))}
              </div>
              <div className="mt-4 flex items-end justify-between">
                <div>
                  <div className="text-xs text-slate-500">每晚起</div>
                  <div className="text-xl font-semibold text-red-600">¥{h.basePrice}</div>
                </div>
                <button className="btn-primary text-sm py-1.5">查看详情</button>
              </div>
            </article>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="card text-slate-500">没有符合条件的酒店，请调整筛选条件。</div>
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">{hotel.emoji} {hotel.name}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <img src={hotel.photo} alt={hotel.name} className="w-full h-52 object-cover rounded-md" />

          <div className="flex items-center gap-3">
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
              {'★'.repeat(hotel.stars)}
            </span>
            <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
              {hotel.rating} / 5
            </span>
            <span className="text-xs text-slate-500">{hotel.reviewCount} 条评价</span>
            <span className="text-xs text-slate-500">· 📍 {hotel.area}</span>
          </div>
          <p className="text-sm text-slate-700 italic">{hotel.highlight}</p>

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
              <div className="flex items-center rounded-md border border-slate-300 overflow-hidden h-9">
                <button
                  type="button"
                  className="px-3 hover:bg-slate-50 disabled:text-slate-300 h-full"
                  disabled={rooms <= 1}
                  onClick={() => setRooms(rooms - 1)}
                >−</button>
                <span className="flex-1 text-center tabular-nums font-medium">{rooms}</span>
                <button
                  type="button"
                  className="px-3 hover:bg-slate-50 disabled:text-slate-300 h-full"
                  disabled={rooms >= 5}
                  onClick={() => setRooms(rooms + 1)}
                >+</button>
              </div>
            </div>
          </div>

          {/* 房型选择 */}
          <div>
            <h3 className="font-medium text-slate-900">选择房型（{hotel.roomTypes.length} 种）</h3>
            <div className="mt-2 space-y-2">
              {hotel.roomTypes.map((r, idx) => {
                const rPrice = Math.round(hotel.basePrice * r.priceMult);
                const selected = idx === selectedRoomIdx;
                return (
                  <button
                    key={r.name}
                    type="button"
                    onClick={() => setSelectedRoomIdx(idx)}
                    className={`w-full text-left rounded-md border-2 p-3 transition ${
                      selected ? 'border-brand bg-brand/5' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{r.name}</span>
                          {selected && <span className="rounded bg-brand px-1.5 py-0.5 text-xs text-white">已选</span>}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {r.bedType} · 可住 {r.sleeps} 人
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-bold text-red-600">¥{rPrice}</div>
                        <div className="text-xs text-slate-400">每晚</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 价格汇总 */}
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
            <div className="flex justify-between text-sm">
              <span className="text-slate-600">{room.name} · ¥{unitPrice}/晚</span>
              <span className="font-medium text-slate-900">¥{unitPrice}</span>
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-slate-600">{actualNights} 晚 × {rooms} 房</span>
              <span className="font-medium text-slate-900">¥{unitPrice * actualNights * rooms}</span>
            </div>
            <div className="mt-3 flex items-end justify-between border-t border-slate-200 pt-3">
              <span className="text-sm text-slate-600">合计</span>
              <span className="text-2xl font-bold text-red-600">¥{total.toLocaleString()}</span>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <button className="btn-secondary" onClick={onClose}>取消</button>
            <button className="btn-secondary" onClick={() => onAdd(room, rooms, false)}>🛒 加入购物车</button>
            <button className="btn-primary" onClick={() => onAdd(room, rooms, true)}>立即购买 →</button>
          </div>
        </div>
      </div>
    </div>
  );
}
