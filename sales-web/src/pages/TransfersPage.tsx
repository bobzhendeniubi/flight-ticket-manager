import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type MockTransfer } from '../lib/mockData';
import { api, type Transfer as ApiTransfer } from '../lib/api';
import { useCart } from '../stores/cart';
import { Icon } from '../components/Icon';

function transferApiToMock(t: ApiTransfer): MockTransfer {
  return {
    id: t.id, name: t.name, vehicleType: t.vehicleType, capacity: t.capacity,
    basePrice: Number(t.basePrice), originArea: t.originArea, destArea: t.destArea,
    emoji: t.emoji ?? '🚗', photo: t.photo ?? '',
    features: t.features, duration: t.duration ?? '',
  };
}

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function TransfersPage() {
  const [transfers, setTransfers] = useState<MockTransfer[]>([]);
  const [pickupAddress, setPickupAddress] = useState('');
  const [pickupDate, setPickupDate] = useState(todayISO(3));
  const [pickupTime, setPickupTime] = useState('07:00');
  const [passengers, setPassengers] = useState(1);
  const [selected, setSelected] = useState<MockTransfer | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listTransfers().then((r) => { if (!cancelled) setTransfers(r.transfers.map(transferApiToMock)); }).catch(() => {/* 静默 */});
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-6">
      <section className="card">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">机场接送 / 包车</h1>
        <p className="mt-1 text-sm text-ink-soft">
          机场点对点 + 当地包车 + 一日游接驳，配中文司机，航班延误自动顺延。
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="md:col-span-2">
            <label className="label">上车地址</label>
            <input
              className="input"
              placeholder="如：酒店名称 / 机场航站楼"
              value={pickupAddress}
              onChange={(e) => setPickupAddress(e.target.value)}
            />
          </div>
          <div>
            <label className="label">用车日期</label>
            <input type="date" className="input" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} />
          </div>
          <div>
            <label className="label">用车时间</label>
            <input type="time" className="input" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
          </div>
          <div>
            <label className="label">乘车人数</label>
            <input
              type="number"
              min={1}
              max={9}
              className="input"
              value={passengers}
              onChange={(e) => setPassengers(Number(e.target.value) || 1)}
            />
          </div>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <p className="section-title">推荐车型</p>
          <p className="text-sm text-ink-muted">{transfers.filter((t) => t.capacity >= passengers).length} 种可选</p>
        </div>
        <div className="space-y-3">
          {transfers.filter((t) => t.capacity >= passengers).map((t) => (
            <article key={t.id} className="card-interactive group flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-6">
              <div className="h-24 w-full flex-shrink-0 overflow-hidden rounded-2xl bg-slate-100 sm:h-20 sm:w-32">
                <img src={t.photo} alt={t.name} className="img-zoom h-full w-full object-cover" onError={(e) => { e.currentTarget.outerHTML = `<div class="grid h-full w-full place-items-center text-5xl">${t.emoji}</div>`; }} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-bold text-ink">{t.name}</h3>
                <p className="mt-0.5 text-sm text-ink-soft">{t.vehicleType}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.features.map((f) => (
                    <span key={f} className="chip">{f}</span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-ink-muted">
                  {t.originArea} → {t.destArea} · 最多 {t.capacity} 人 · {t.duration}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-slate-100 pt-3 sm:block sm:border-0 sm:pt-0 sm:text-right">
                <div>
                  <div className="text-xs text-ink-muted">起步价</div>
                  <div className="price text-2xl">¥{t.basePrice}</div>
                </div>
                <button className="btn-deal text-sm sm:mt-2" onClick={() => setSelected(t)}>
                  立即预订
                </button>
              </div>
            </article>
          ))}
        </div>

        {transfers.filter((t) => t.capacity >= passengers).length === 0 && (
          <div className="card text-ink-soft">没有足够大的车型，请减少乘车人数。</div>
        )}
      </section>

      {selected && (
        <BookModal
          transfer={selected}
          pickupAddress={pickupAddress || '（未填写）'}
          pickupDate={pickupDate}
          pickupTime={pickupTime}
          passengers={passengers}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function BookModal(props: {
  transfer: MockTransfer;
  pickupAddress: string;
  pickupDate: string;
  pickupTime: string;
  passengers: number;
  onClose: () => void;
}) {
  const { transfer, pickupAddress, pickupDate, pickupTime, passengers, onClose } = props;
  const add = useCart((s) => s.add);
  const navigate = useNavigate();

  const addToCart = (goCart: boolean) => {
    add({
      kind: 'TRANSFER',
      productId: transfer.id,
      name: transfer.name,
      description: `${pickupDate} ${pickupTime} · ${pickupAddress} → ${transfer.destArea} · ${passengers} 人`,
      emoji: transfer.emoji,
      unitPrice: transfer.basePrice,
      qty: 1,
      meta: { pickupDate, pickupTime, passengers, destArea: transfer.destArea },
    });
    onClose();
    if (goCart) navigate('/cart');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-3xl bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200/80 px-6 py-4">
          <h2 className="text-lg font-extrabold tracking-tight text-ink">确认用车信息</h2>
          <button className="text-xl text-ink-muted transition-colors hover:text-ink" onClick={onClose}>×</button>
        </div>
        <div className="px-6 py-5">
          <dl className="space-y-2.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-soft">车型</dt>
              <dd className="inline-flex items-center gap-1.5 font-medium text-ink">
                <Icon name="car" className="h-4 w-4 text-brand" />{transfer.name}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-soft">上车地址</dt>
              <dd className="font-medium text-ink">{pickupAddress}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-soft">目的地</dt>
              <dd className="font-medium text-ink">{transfer.destArea}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-soft">用车时间</dt>
              <dd className="font-medium text-ink">{pickupDate} {pickupTime}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-soft">乘车人数</dt>
              <dd className="font-medium text-ink">{passengers} 人</dd>
            </div>
            <div className="flex items-end justify-between border-t border-slate-200 pt-3">
              <dt className="text-ink-soft">应付</dt>
              <dd className="price text-xl">¥{transfer.basePrice}</dd>
            </div>
          </dl>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-200/80 bg-canvas px-6 py-4">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <div className="flex gap-2">
            <button className="btn-secondary inline-flex items-center gap-1.5" onClick={() => addToCart(false)}>
              <Icon name="cart" className="h-4 w-4" />加入购物车
            </button>
            <button className="btn-deal inline-flex items-center gap-1.5" onClick={() => addToCart(true)}>
              立即购买 <Icon name="arrowRight" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
