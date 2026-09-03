import type { PublicLegStatus } from './api';

/**
 * 航段状态的买家口吻文案（唯一定义处）。
 *
 * 后端只下发中性枚举（publicLegStatus），中文一律写在这里：
 * 我的订单、订单查询等处共用同一句话，避免同一状态在各页面慢慢写岔。
 *
 * 口径：只说「这段行程现在是什么情况、要客人做什么」，不解释我方内部怎么处理。
 *   · 回程暂时没有班次 → 告诉客人待重新安排、想保留就找人；
 *   · 去程未登机 → 客人自己清楚，页面不必再说一遍（null = 不显示额外文案）。
 */
const LEG_STATUS_NOTE: Record<PublicLegStatus, string | null> = {
  RETURN_PENDING_REARRANGE: '回程待重新安排，如需保留请联系客服或代理',
  RETURN_CANCELLED: '回程已取消',
  OUTBOUND_CANCELLED: '去程已取消',
  OUTBOUND_NOT_BOARDED: null,
};

/** 取该航段状态要显示的一句话；无状态 / 无需解释 → null（调用处不渲染）。 */
export function legStatusNote(status?: PublicLegStatus | null): string | null {
  return status ? LEG_STATUS_NOTE[status] : null;
}
