import { Link, useNavigate } from 'react-router-dom';
import { useCart, KIND_INFO } from '../stores/cart';

export function CartPage() {
  const items = useCart((s) => s.items);
  const remove = useCart((s) => s.remove);
  const updateQty = useCart((s) => s.updateQty);
  const clear = useCart((s) => s.clear);
  const total = useCart((s) => s.items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0));
  const navigate = useNavigate();

  if (items.length === 0) {
    return (
      <div className="card text-center py-16">
        <div className="text-5xl">🛒</div>
        <p className="mt-3 text-slate-600">购物车空空如也</p>
        <Link to="/" className="btn-primary mt-4 inline-block">
          去搜机票
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section>
        <h1 className="text-2xl font-bold text-slate-900">购物车</h1>
        <p className="mt-1 text-sm text-slate-600">
          共 {items.reduce((s, i) => s + i.qty, 0)} 件商品 · 总价 ¥{total.toLocaleString()}
        </p>
      </section>

      <section className="card p-0 overflow-hidden">
        <ul className="divide-y divide-slate-200">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-4 p-4">
              <div className="text-3xl">{i.emoji}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_INFO[i.kind].color}`}
                  >
                    {KIND_INFO[i.kind].label}
                  </span>
                  <h3 className="font-medium text-slate-900 truncate">{i.name}</h3>
                </div>
                {i.description && (
                  <p className="mt-0.5 text-xs text-slate-500 truncate">{i.description}</p>
                )}
                {/* 套餐: 显示航班明细 */}
                {i.kind === 'BUNDLE' && i.meta && (
                  <div className="mt-1 text-xs text-slate-500 space-y-0.5">
                    <div>✈ QH9589 澳门→岘港 {String(i.meta.goDate)} + QH9588 回程 {String(i.meta.returnDate)}</div>
                    <div>
                      {Number(i.meta.pax) || 0} 人 · {Number(i.meta.rooms) || 1} 房 ·
                      机票 ¥{Number(i.meta.flightTotal || 0).toLocaleString()} +
                      地面 ¥{Number(i.meta.hotelTotal || 0).toLocaleString()} +
                      其他 ¥{Number(i.meta.otherTotal || 0).toLocaleString()}
                      {Number(i.meta.discount) > 0 && ` − 让利 ¥${Number(i.meta.discount).toLocaleString()}`}
                    </div>
                  </div>
                )}
                {/* 机票: 显示舱等+日期 */}
                {i.kind === 'FLIGHT' && i.meta && (
                  <div className="mt-1 text-xs text-slate-500">
                    {String(i.meta.cabin) === 'BUSINESS' ? '商务舱' : '经济舱'} · {String(i.meta.departureTime).slice(0, 10)} ·
                    日期等级 {String(i.meta.dateRank)} · {Number(i.meta.passengers)} 人
                  </div>
                )}
                <p className="mt-0.5 text-xs text-slate-400">
                  加入时间 {new Date(i.addedAt).toLocaleString('zh-CN')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
                  onClick={() => updateQty(i.id, i.qty - 1)}
                  disabled={i.qty <= 1}
                >
                  −
                </button>
                <span className="w-8 text-center tabular-nums">{i.qty}</span>
                <button
                  className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
                  onClick={() => updateQty(i.id, i.qty + 1)}
                >
                  +
                </button>
              </div>
              <div className="w-24 text-right">
                <div className="text-sm text-slate-500">¥{i.unitPrice}</div>
                <div className="text-base font-semibold text-red-600">
                  ¥{(i.unitPrice * i.qty).toLocaleString()}
                </div>
              </div>
              <button
                className="text-xs text-slate-400 hover:text-red-600"
                onClick={() => remove(i.id)}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-between">
          <button className="text-sm text-slate-500 hover:text-red-600" onClick={clear}>
            清空购物车
          </button>
          <div className="flex items-center gap-4">
            <div>
              <span className="text-sm text-slate-600">合计：</span>
              <span className="text-2xl font-bold text-red-600">¥{total.toLocaleString()}</span>
            </div>
            <button className="btn-primary" onClick={() => navigate('/checkout')}>
              去结账 →
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
