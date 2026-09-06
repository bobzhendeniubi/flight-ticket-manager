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
 * 未知 reason（后端新增、老前端还不认识）一律走兜底文案「该日期暂不可售」并照常拦截——
 * 绝不因为不认识就放行，也绝不把内部原因码原样透给买家。
 */

/** 各原因的客户向文案（buyer POV）；null = 可售（不展示徽章）。 */
const REASON_TEXT: Record<string, string> = {
  BLACKOUT: '该日期暂不可售 · 封盘',
  // 套餐没绑航班 = 没航线，整段区间都订不了；这是产品配置问题，不是"换个日期"能解决的，
  // 所以文案不提日期，也不透露内部原因（买家不需要知道后台绑没绑航班）。
  NO_FLIGHT_BOUND: '该套餐暂未开放预订',
  FLIGHT_SOLD_OUT: '该日期机位已满',
  HOTEL_SOLD_OUT: '该日期满房',
};

/** 认不出的 reason 的兜底文案（后端新增分支时老前端仍能给买家一句人话）。 */
const FALLBACK_TEXT = '该日期暂不可售';

/** 各原因后面跟的建议；未列出的用「换个日期试试」。 */
const REASON_HINT: Record<string, string> = {
  NO_FLIGHT_BOUND: '看看其他套餐',
};

const FALLBACK_HINT = '换个日期试试';

/** 该原因给买家看的一句话（未知 reason → 兜底文案）。 */
function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? FALLBACK_TEXT;
}

/** 该原因是否应拦截加购（任一非空原因都拦截，含不认识的新原因）。 */
export function isSellableBlocked(reason: SellableDateReason): boolean {
  return reason != null && reason !== '';
}

/** 加购按钮 title / disable 提示文案（可售 → undefined）。 */
export function sellableBlockTitle(reason: SellableDateReason): string | undefined {
  if (!isSellableBlocked(reason)) return undefined;
  const key = reason as string;
  return `${reasonText(key)}，${REASON_HINT[key] ?? FALLBACK_HINT}`;
}

export function SellableReasonChip({ reason }: { reason: SellableDateReason }) {
  if (!isSellableBlocked(reason)) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-deal/30 bg-deal-light px-2 py-0.5 text-[11px] font-semibold text-deal-dark">
      <Icon name="info" className="h-3 w-3" />
      {reasonText(reason as string)}
    </span>
  );
}
