import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart, KIND_INFO, isSelected, type CartItem } from '../stores/cart';
import { Icon, type IconName } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { RefundBadge } from '../components/RefundBadge';
import { TrustBadges } from '../components/TrustBadges';

/** 购物车条目按 kind 映射统一线性图标（取代存储的 emoji 渲染；不改 store 里的 emoji 字段） */
const CART_KIND_ICON: Record<CartItem['kind'], IconName> = {
  FLIGHT: 'plane',
  HOTEL: 'hotel',
  TRANSFER: 'car',
  VISA: 'visa',
  BUNDLE: 'package',
};

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
  const selectedItems = useMemo(() => items.filter(isSelected), [items]);
  const selectedTotal = selectedItems.reduce((sum, i) => sum + (Number(i.unitPrice) * Number(i.qty) || 0), 0);
  const selectedCount = selectedItems.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const allSelected = items.length > 0 && selectedItems.length === items.length;

  if (items.length === 0) {
    return (
      <div className="card animate-fade-up">
        <EmptyState
          icon="cart"
          title="购物车空空如也"
          hint="挑选海岛专线机票或一价全含套餐，开启你的旅程"
          action={
            <Link to="/" className="btn-primary inline-flex items-center gap-1.5">
              去逛逛 <Icon name="arrowRight" className="h-4 w-4" />
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-36 lg:pb-0">
      <section className="animate-fade-up">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">购物车</h1>
        <p className="section-sub">
          共 {items.reduce((s, i) => s + (Number(i.qty) || 0), 0)} 件商品 · 已选{' '}
          <span className="font-semibold text-ink">{selectedCount}</span> 件 · 已选合计{' '}
          <span className="price text-base">¥{fmt(selectedTotal)}</span>
        </p>
      </section>

      <div className="lg:grid lg:grid-cols-[1fr_320px] lg:items-start lg:gap-5">
        <section className="card overflow-hidden p-0">
          {/* 全选 / 全不选 */}
          <label className="flex cursor-pointer items-center gap-2.5 border-b border-slate-200/80 bg-canvas px-4 py-3">
            <input
              type="checkbox"
              className="h-4 w-4 rounded accent-brand"
              checked={allSelected}
              onChange={(e) => setAllSelected(e.target.checked)}
            />
            <span className="text-sm font-medium text-ink-soft">全选（勾选要结账的产品，未勾的留在车里）</span>
          </label>
          <ul className="divide-y divide-slate-100">
            {items.map((i) => (
              <li
                key={i.id}
                className={`flex flex-wrap items-center gap-3 p-4 transition-opacity sm:gap-4 ${isSelected(i) ? '' : 'opacity-50'}`}
              >
                <input
                  type="checkbox"
                  className="h-5 w-5 flex-shrink-0 rounded accent-brand"
                  checked={isSelected(i)}
                  onChange={() => toggleSelected(i.id)}
                  aria-label="选择结账"
                />
                <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand">
                  <Icon name={CART_KIND_ICON[i.kind]} className="h-7 w-7" />
                </div>
                <div className="min-w-[55%] flex-1 sm:min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${KIND_INFO[i.kind].color}`}
                    >
                      {KIND_INFO[i.kind].label}
                    </span>
                    <h3 className="truncate font-semibold text-ink">{i.name}</h3>
                  </div>
                  {i.description && (
                    <p className="mt-0.5 truncate text-xs text-ink-muted">{i.description}</p>
                  )}
                  {/* 套餐: 显示航班明细 */}
                  {i.kind === 'BUNDLE' && i.meta && (
                    <div className="mt-1.5 space-y-0.5 text-xs text-ink-soft">
                      <div className="inline-flex items-center gap-1">
                        <Icon name="plane" className="h-3 w-3 shrink-0" />
                        QH9589 澳门→岘港 {String(i.meta?.goDate ?? '')} + QH9588 回程 {String(i.meta?.returnDate ?? '')}
                      </div>
                      <div>
                        {Number(i.meta?.pax) || 0} 人 · {Number(i.meta?.rooms) || 1} 房 ·
                        机票 ¥{fmt(Number(i.meta?.flightTotal) || 0)} +
                        地面 ¥{fmt(Number(i.meta?.hotelTotal) || 0)} +
                        其他 ¥{fmt(Number(i.meta?.otherTotal) || 0)}
                        {(Number(i.meta?.discountPct) || 0) > 0 && ` − 已省 ${Number(i.meta?.discountPct) || 0}%`}
                      </div>
                    </div>
                  )}
                  {/* 机票: 显示舱等+日期+人数（dateRank 是内部字段，不展示给客户） */}
                  {i.kind === 'FLIGHT' && i.meta && (
                    <div className="mt-1.5 text-xs text-ink-soft">
                      {String(i.meta?.cabin ?? '') === 'BUSINESS' ? '商务舱' : '经济舱'} · {String(i.meta?.departureTime ?? '').slice(0, 10)} · {Number(i.meta?.passengers) || 0} 人
                    </div>
                  )}
                  <p className="mt-1 text-xs text-ink-muted">
                    加入时间 {new Date(i.addedAt).toLocaleString('zh-CN')}
                  </p>
                </div>
                {/* 手机端：qty/价格/删除 整体换到下一行（占满宽度，end 对齐） */}
                <div className="ml-auto mt-2 flex w-full flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3 sm:mt-0 sm:w-auto sm:flex-nowrap sm:gap-3 sm:border-t-0 sm:pt-0">
                  <div className="flex items-center gap-1 rounded-xl border border-slate-200 p-0.5">
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-soft transition hover:bg-brand-50 hover:text-brand-700 disabled:opacity-40 sm:h-7 sm:w-7"
                      onClick={() => updateQty(i.id, i.qty - 1)}
                      disabled={i.qty <= 1}
                    >
                      −
                    </button>
                    <span className="w-7 text-center text-sm font-semibold tabular-nums">{i.qty}</span>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-soft transition hover:bg-brand-50 hover:text-brand-700 sm:h-7 sm:w-7"
                      onClick={() => updateQty(i.id, i.qty + 1)}
                    >
                      +
                    </button>
                  </div>
                  <div className="min-w-[80px] text-right sm:w-24">
                    <div className="hidden text-xs text-ink-muted sm:block">¥{fmt(i.unitPrice)}</div>
                    <div className="price text-sm sm:text-base">¥{fmt(i.unitPrice * i.qty)}</div>
                  </div>
                  <button
                    className="flex h-8 flex-shrink-0 items-center rounded-lg border border-slate-200 px-2.5 text-xs font-medium whitespace-nowrap text-ink-soft transition hover:border-deal/50 hover:bg-deal-light hover:text-deal sm:py-1.5"
                    onClick={() => remove(i.id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-canvas px-4 py-3">
            <div className="flex items-center gap-3">
              <button className="text-sm font-medium text-ink-muted transition hover:text-deal" onClick={clear}>
                清空购物车
              </button>
              <Link
                to="/"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition hover:text-brand-dark"
              >
                <Icon name="arrowRight" className="h-3.5 w-3.5 rotate-180" /> 继续挑选
              </Link>
            </div>
            <span className="text-xs text-ink-muted">仅勾选的商品会进入结算</span>
          </div>
        </section>

        {/* 结算汇总 — 桌面端右侧 sticky，手机端固定底部 */}
        <aside className="hidden lg:sticky lg:top-24 lg:block">
          <div className="card space-y-4">
            <h2 className="section-title text-base">结算汇总</h2>
            <div className="flex items-center justify-between text-sm text-ink-soft">
              <span>已选商品</span>
              <span className="font-semibold text-ink nums">{selectedCount} 件</span>
            </div>
            <div className="flex items-end justify-between border-t border-slate-100 pt-3">
              <span className="text-sm text-ink-soft">已选合计</span>
              <span className="price text-2xl">¥{fmt(selectedTotal)}</span>
            </div>
            <button
              className="btn-deal inline-flex w-full items-center justify-center gap-1.5"
              disabled={selectedItems.length === 0}
              onClick={() => navigate('/checkout')}
            >
              结算所选 {selectedCount} 件 <Icon name="arrowRight" className="h-4 w-4" />
            </button>
            <div className="flex justify-center">
              <RefundBadge />
            </div>
            <div className="border-t border-slate-100 pt-3">
              <TrustBadges variant="card" />
            </div>
          </div>
        </aside>
      </div>

      {/* 手机端 sticky 底部结算条 */}
      <div className="fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-40 border-t border-slate-200/80 bg-surface/95 px-4 py-3 shadow-pop backdrop-blur-xl lg:hidden">
        <div className="mb-2 flex items-center gap-1.5 text-xs text-ink-soft">
          <Icon name="shield" className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          出发前 7 天免费取消 · 安全支付
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-ink-muted">已选 {selectedCount} 件 · 合计</div>
            <div className="price text-xl">¥{fmt(selectedTotal)}</div>
          </div>
          <button
            className="btn-deal inline-flex flex-shrink-0 items-center gap-1.5 px-6"
            disabled={selectedItems.length === 0}
            onClick={() => navigate('/checkout')}
          >
            去结算 <Icon name="arrowRight" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
