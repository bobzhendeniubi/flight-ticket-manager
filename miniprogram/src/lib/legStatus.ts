import type { PublicLegStatus } from './types';

/**
 * 航段状态的买家口吻文案（小程序侧唯一定义处，与前台商城同一套话术）。
 *
 * 后端只下发中性枚举（publicLegStatus），中文写在这里：订单列表与订单详情共用一句话。
 * 口径：只说「这段行程现在是什么情况、要客人做什么」，不解释我方内部怎么处理；
 * 去程未登机客人自己清楚，页面不必再说一遍（null = 不显示额外文案）。
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
