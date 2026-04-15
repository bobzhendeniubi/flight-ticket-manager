import { useState } from 'react';
import { MOCK_TRANSFERS, type MockTransfer } from '../lib/mockData';

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function TransfersPage() {
  const [pickupAddress, setPickupAddress] = useState('');
  const [pickupDate, setPickupDate] = useState(todayISO(3));
  const [pickupTime, setPickupTime] = useState('07:00');
  const [passengers, setPassengers] = useState(1);
  const [selected, setSelected] = useState<MockTransfer | null>(null);

  return (
    <div className="space-y-6">
      <section className="card">
        <h1 className="text-2xl font-bold text-slate-900">机场接送</h1>
        <p className="mt-1 text-sm text-slate-600">
          专车接送机服务，含专职司机 + 免费等候，航班延误自动顺延。
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="md:col-span-2">
            <label className="label">上车地址</label>
            <input
              className="input"
              placeholder="如：朝阳区建外 SOHO"
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
        <p className="text-sm text-slate-500 mb-3">推荐 {MOCK_TRANSFERS.length} 种车型</p>
        <div className="space-y-3">
          {MOCK_TRANSFERS.filter((t) => t.capacity >= passengers).map((t) => (
            <article key={t.id} className="card flex items-center gap-6 hover:shadow-md transition">
              <div className="text-5xl">{t.emoji}</div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-slate-900">{t.name}</h3>
                <p className="mt-1 text-sm text-slate-600">{t.vehicleType}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.features.map((f) => (
                    <span key={f} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {f}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {t.originArea} → {t.destArea} · 最多 {t.capacity} 人
                </p>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">起步价</div>
                <div className="text-2xl font-bold text-red-600">¥{t.basePrice}</div>
                <button className="btn-primary mt-2 text-sm" onClick={() => setSelected(t)}>
                  立即预订
                </button>
              </div>
            </article>
          ))}
        </div>

        {MOCK_TRANSFERS.filter((t) => t.capacity >= passengers).length === 0 && (
          <div className="card text-slate-500">没有足够大的车型，请减少乘车人数。</div>
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
  const [booked, setBooked] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">确认用车信息</h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>×</button>
        </div>
        <div className="px-6 py-5">
          {booked ? (
            <div className="rounded-md bg-green-50 p-5 text-green-700">
              <div className="text-2xl">✅</div>
              <h3 className="mt-2 text-lg font-semibold">用车已下单（demo）</h3>
              <p className="mt-1 text-sm">
                司机将于上车前 30 分钟联系您。订单号：FTM{Date.now().toString().slice(-10)}
              </p>
              <button className="btn-secondary mt-4" onClick={onClose}>关闭</button>
            </div>
          ) : (
            <>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-600">车型</dt>
                  <dd className="text-slate-900">{transfer.emoji} {transfer.name}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600">上车地址</dt>
                  <dd className="text-slate-900">{pickupAddress}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600">目的地</dt>
                  <dd className="text-slate-900">{transfer.destArea}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600">用车时间</dt>
                  <dd className="text-slate-900">{pickupDate} {pickupTime}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600">乘车人数</dt>
                  <dd className="text-slate-900">{passengers} 人</dd>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-2">
                  <dt className="text-slate-600">应付</dt>
                  <dd className="text-xl font-bold text-red-600">¥{transfer.basePrice}</dd>
                </div>
              </dl>
              <div className="mt-5 flex justify-end gap-3">
                <button className="btn-secondary" onClick={onClose}>取消</button>
                <button className="btn-primary" onClick={() => setBooked(true)}>
                  确认下单
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
