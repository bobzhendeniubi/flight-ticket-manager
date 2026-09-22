/**
 * 订单里的乘客姓名 → 旅客档案页链接。
 *
 * 档案页（/travelers）此前只能从菜单进去再搜一遍，订单里看到一个名字想知道「这人飞过几次、
 * 买过什么」够不着。这里统一拼两种入口：
 *   · 已知档案 id（订单详情 / 展开子行批量查次数时顺带拿到）→ /travelers?profile=<id>，
 *     档案 id 不是敏感信息，留在地址栏里可分享可刷新；
 *   · 只有证件号 → 走 react-router 的 Link state 传给档案页解析，**不进地址栏**：
 *     证件号（护照号）落进 URL 就会一路留在浏览器历史、日志与分享出去的链接里。
 *     代价是刷新后 state 丢失（档案页回到普通列表），可以接受。
 * 两种入口都不额外发请求（列表侧不为了拼链接多打一次接口）。
 */

/** 档案页从 location.state 里读的载荷（不进地址栏）。 */
export interface TravelerProfileLinkState {
  doc: string;
  docType: string;
  /** 从这张单点「去核销」进来时带上；档案页打开后自动展开核销表单并尝试预选这张单。 */
  orderId?: string;
}

/** 直接摊给 <Link> 的属性。 */
export interface TravelerProfileLinkProps {
  to: string;
  state?: TravelerProfileLinkState;
}

/**
 * 证件号也没有时返回 null —— 调用方据此渲染成纯文本，不给一个必然落空的链接。
 * orderId 可选：带上就是「去核销」场景——订单 id 不是敏感信息，档案 id 已知时直接拼进地址栏
 * （同 profileId 的口径），只有证件号时随 Link state 一起带过去，不单独处理。
 */
export function travelerProfileLinkProps(params: {
  profileId?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  orderId?: string | null;
}): TravelerProfileLinkProps | null {
  const profileId = params.profileId?.trim();
  const orderId = params.orderId?.trim();
  if (profileId) {
    const qs = new URLSearchParams({ profile: profileId });
    if (orderId) qs.set('orderId', orderId);
    return { to: `/travelers?${qs.toString()}` };
  }
  const doc = params.documentNumber?.trim();
  if (!doc) return null;
  return {
    to: '/travelers',
    state: { doc, docType: params.documentType?.trim() || 'PASSPORT', ...(orderId ? { orderId } : {}) },
  };
}

/** 链接的悬浮说明，三处入口共用一句话。 */
export const TRAVELER_PROFILE_LINK_TITLE = '查看旅客档案（飞过几次、买过什么）';
