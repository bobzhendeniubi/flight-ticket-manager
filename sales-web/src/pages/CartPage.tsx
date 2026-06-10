import { Link, useNavigate } from 'react-router-dom';
import { useCart, KIND_INFO, isSelected } from '../stores/cart';

/** 金额渲染兜底：非法数值显示 '0' 而不是 NaN（白屏类反馈的修复之一） */
function fmt(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

export function CartPage() {
  const items = useCart((s) => s.items);
  const remove = useCart((s) => s.remove);
  const updateQty = useCart((s) => s.updateQty);
  const toggleSelected = useCart((s) => s.toggleSelected);
  const setAllSelected = useCart((s) => s.setAllSelected);
  const clear = useCart((s) => s.clear);
  const navigate = useNavigate();

  // 只结算勾选的产品（代理可挑着付，剩下的留在车里）
  const selectedItems = items.filter(isSelected);
  const selectedTotal = selectedItems.reduce((sum, i) => sum + (Number(i.unitPrice) * Number(i.qty) || 0), 0);
  const selectedCount = selectedItems.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const allSelected = items.length > 0 && selectedItems.length === items.length;

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
          共 {items.reduce((s, i) => s + (Number(i.qty) || 0), 0)} 件商品 · 已选 {selectedCount} 件 · 已选合计 ¥{fmt(selectedTotal)}
        </p>
      </section>

      <section className="card p-0 overflow-hidden">
        {/* 全选 / 全不选 */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <input
            type="checkbox"
            className="h-4 w-4 accent-brand"
            checked={allSelected}
            onChange={(e) => setAllSelected(e.target.checked)}
          />
          <span className="text-sm text-slate-600">全选（勾选要结账的产品，未勾的留在车里）</span>
        </div>
        <ul className="divide-y divide-slate-200">
          {items.map((i) => (
            <li
              key={i.id}
              className={`flex flex-wrap items-center gap-3 sm:gap-4 p-3 sm:p-4 ${isSelected(i) ? '' : 'opacity-50'}`}
            >
              <input
                type="checkbox"
                className="h-5 w-5 flex-shrink-0 accent-brand"
                checked={isSelected(i)}
                onChange={() => toggleSelected(i.id)}
                aria-label="选择结账"
              />
              <div className="text-2xl sm:text-3xl flex-shrink-0">{i.emoji}</div>
              <div className="flex-1 min-w-[60%] sm:min-w-0">
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
                    <div>✈ QH9589 澳门→岘港 {String(i.meta?.goDate ?? '')} + QH9588 回程 {String(i.meta?.returnDate ?? '')}</div>
                    <div>
                      {Number(i.meta?.pax) || 0} 人 · {Number(i.meta?.rooms) || 1} 房 ·
                      机票 ¥{fmt(Number(i.meta?.flightTotal) || 0)} +
                      地面 ¥{fmt(Number(i.meta?.hotelTotal) || 0)} +
                      其他 ¥{fmt(Number(i.meta?.otherTotal) || 0)}
                      {(Number(i.meta?.discount) || 0) > 0 && ` − 让利 ¥${fmt(Number(i.meta?.discount) || 0)}`}
                    </div>
                  </div>
                )}
                {/* 机票: 显示舱等+日期+人数（dateRank 是内部字段，不展示给客户） */}
                {i.kind === 'FLIGHT' && i.meta && (
                  <div className="mt-1 text-xs text-slate-500">
                    {String(i.meta?.cabin ?? '') === 'BUSINESS' ? '商务舱' : '经济舱'} · {String(i.meta?.departureTime ?? '').slice(0, 10)} · {Number(i.meta?.passengers) || 0} 人
                  </div>
                )}
                <p className="mt-0.5 text-xs text-slate-400">
                  加入时间 {new Date(i.addedAt).toLocaleString('zh-CN')}
                </p>
              </div>
              {/* 手机端：qty/价格/删除 整体换到下一行（占满宽度，end 对齐） */}
              <div className="flex items-center gap-3 ml-auto w-full sm:w-auto justify-end mt-2 sm:mt-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100">
                <div className="flex items-center gap-2">
                  <button
                    className="rounded border border-slate-300 w-7 h-7 hover:bg-slate-50 leading-none"
                    onClick={() => updateQty(i.id, i.qty - 1)}
                    disabled={i.qty <= 1}
                  >
                    −
                  </button>
                  <span className="w-7 text-center tabular-nums">{i.qty}</span>
                  <button
                    className="rounded border border-slate-300 w-7 h-7 hover:bg-slate-50 leading-none"
                    onClick={() => updateQty(i.id, i.qty + 1)}
                  >
                    +
                  </button>
                </div>
                <div className="text-right min-w-[80px] sm:w-24">
                  <div className="text-xs text-slate-500 hidden sm:block">¥{fmt(i.unitPrice)}</div>
                  <div className="text-sm sm:text-base font-semibold text-red-600">
                    ¥{fmt(i.unitPrice * i.qty)}
                  </div>
                </div>
                <button
                  className="flex-shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-red-400 hover:bg-red-50 hover:text-red-600"
                  onClick={() => remove(i.id)}
                >
                  🗑 删除
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-between">
          <button className="text-sm text-slate-500 hover:text-red-600" onClick={clear}>
            清空购物车
          </button>
          <div className="flex items-center gap-4">
            <div>
              <span className="text-sm text-slate-600">已选合计：</span>
              <span className="text-2xl font-bold text-red-600">¥{fmt(selectedTotal)}</span>
            </div>
            <button
              className="btn-primary disabled:opacity-50"
              disabled={selectedItems.length === 0}
              onClick={() => navigate('/checkout')}
            >
              结算所选 {selectedCount} 件 →
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
