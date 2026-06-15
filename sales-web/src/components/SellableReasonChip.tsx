import { Icon } from './Icon';
import type { SellableDateReason } from '../lib/api';

/**
 * 套餐可售日期 —— 所选日期不在可售区间时的原因小徽章 + 加购禁用文案。
 *
 * 原生 <input type=date> 无法逐日置灰，min/max 只能框住区间端点；用户仍可能
 * 手动键入区间内的封盘 / 售罄日。此时保留所选日期值（不静默回弹），在输入框旁
 * 显示本徽章说明原因，并复用既有 soldOut 禁用路径拦截加购（见各页 disable 逻辑）。
 *
 * 库存纪律：只说"封盘 / 机位已满 / 满房"，绝不暴露原始余票/余房数字。
 */

/** 各原因的客户向文案（buyer POV）；null = 可售（不展示徽章）。 */
const REASON_TEXT: Record<Exclude<SellableDateReason, null>, string> = {
  BLACKOUT: '该日期暂不可售 · 封盘',
  FLIGHT_SOLD_OUT: '该日期机位已满',
  HOTEL_SOLD_OUT: '该日期满房',
};

/** 该原因是否应拦截加购（任一非 null 原因都拦截）。 */
export function isSellableBlocked(reason: SellableDateReason): boolean {
  return reason !== null;
}

/** 加购按钮 title / disable 提示文案（可售 → undefined）。 */
export function sellableBlockTitle(reason: SellableDateReason): string | undefined {
  return reason ? `${REASON_TEXT[reason]}，换个日期试试` : undefined;
}

export function SellableReasonChip({ reason }: { reason: SellableDateReason }) {
  if (!reason) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-deal/30 bg-deal-light px-2 py-0.5 text-[11px] font-semibold text-deal-dark">
      <Icon name="info" className="h-3 w-3" />
      {REASON_TEXT[reason]}
    </span>
  );
}
