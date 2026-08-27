/**
 * 导出层「出发日期」精确细筛 —— 全岗总表 / 三模板 两处共享。
 *
 * 背景（0722 公测反馈 · 财务岗）：按出发日期导出《全岗可用》，本想只要「当天出发」的订单，
 * 实际却把出行日期及**返程**日期落在窗口内的数据也导了进来。
 *
 * 根因：列表/导出的取数 where（buildOrderFilterWhere 的 travelFrom/travelTo）出于「宁可多召回、
 * 不漏单」故意做了两件放宽 ——
 *   1. 窗口各向外 ±1 天（UTC 与出发地 +8 跨午夜的边界防漏）；
 *   2. `items.some.OR[ 任意 FLIGHT 行的班次出发时间, 任意酒店入住日 ]` —— 只要**任一**航段
 *      （含返程）或**任一**入住日落在窗口内就召回。
 * 于是「去程 21 号、回程 22 号」这类整单出发日在窗口外的往返单，会因返程段落在窗口内被捞进来。
 *
 * 取数层的宽召回口径**保持不动**（列表页依赖它防漏单）；本模块只在导出把数据取回内存后，
 * 按「整单出发日」二次精确过滤。整单出发日的判定复用订单列表「出发日期」列同一函数
 * （orders.service.filterOrderIdsByDepartDate → deriveOrderDepartDate：本单最早 FLIGHT 行的班次
 * 出发日；无航班回退最早酒店入住日），因此「导出所得 = 列表所见」。
 *
 * ── 无锚点订单的口径（反馈：签证岗；导出侧与列表侧**故意不同**，别顺手统一）──
 * 「锚点」= 能派生出整单出发日的字段，三选一：最早航段出发时间 / 最早酒店入住日 /
 * 最早 VISA 行的预计出行日期（visaIntendedDate —— 签证业务本身没有航班和住宿，
 * 「打算什么时候走」就是它的业务日期锚点）。
 *
 *   导出（本模块）—— 无锚点的**签证单**保留。导出是「把这批单交出去办事」：一张没填日期的
 *     签证单被静默剔除，签证岗就整批看不到自己的单。宁可多带一张让人自己划掉，也不能让它
 *     凭空消失。与签证台看板对纯签证单的保护（fulfillment.service）同一口径。
 *   列表（orders.service.filterOrderIdsByDepartDate）—— 无锚点单**排除**，维持现状。列表的日期
 *     筛选是「找某天走的单」：无日期单若无条件保留，就会出现在**每一个**日期区间里，筛选失效。
 *
 * 豁免只给签证单（收窄，P1-7）：这条例外的**理由**是「签证业务本身没有航班和住宿，没填预计
 * 出行日期就彻底无处归日」——只有涉签的单才配得上它。若按「一个日期锚点都没有」无差别保留，
 * 空单、纯接送单、资料还没录全的机酒单会跟着混进**每一个**指定日期的导出里。涉签判定与签证
 * 任务锚点同源：含 VISA 行，或含「组件里有签证」的套餐行（Bundle.items JSON）。
 *
 * 所以本模块不能直接复用 filterOrderIdsByDepartDate 的命中集合（那是列表口径），改为按
 * deriveOrderDepartDate 逐单判：派生得出日期 → 按窗口筛；派生不出 → 涉签才保留、否则剔除。
 * 两侧共用同一个派生函数，保证「**有锚点**的单，导出所得 = 列表所见」，差异只落在无锚点这一类。
 *
 * 取数层前置条件（已打通）：能否真的捞到纯签证单，取决于 buildOrderFilterWhere 的
 * travelFrom/travelTo 是否召回它们。该 where 现已具备两件事：
 *   1. `items.some.OR` 补上第三支「签证预计出行日期 visaIntendedDate 落在窗口内」
 *      —— 填了日期的签证单按锚点正常命中（列表与导出同得此益）；
 *   2. 导出调用链（全岗总表 / 三模板）传 `includeAnchorless: true`，再 OR 上一支
 *      「不含任何带日期锚点行」AND「含 VISA 行或含签证组件套餐行」—— 连日期都没填的签证单
 *      也一并取回，交给本模块兜底。取数层与本模块**同一收窄口径**，两边不会各筛各的。
 *      列表路径不传该参，维持排除口径不变。
 */
import { deriveOrderDepartDate } from './orders.service.js';

/**
 * 本单是否「涉签」—— 与签证任务锚点（orders.service.resolveVisaTaskAnchor）同源的商品级判定：
 * 含 VISA 行，或含「组件里有签证」的 BUNDLE 行（Bundle.items JSON 数组，形如 [{kind:'VISA'}...]）。
 *
 * 只看商品级、不看订单级 visaStatus：无锚点豁免的理由是「签证业务没有航班和住宿、无处归日」，
 * 那是商品形态决定的；一张机酒单把 visaStatus 标成需签，它照样有航班/入住日可归。
 *
 * 取数 where 的对应分支（buildOrderFilterWhere 的 anchorlessVisaOnly）与此同一口径 ——
 * 各导出的 include 均已联查 `bundle: { select: { items } }`，形状满足。
 */
function orderHasVisaScope(items: ReadonlyArray<Record<string, unknown>>): boolean {
  return items.some((item) => {
    if (item.kind === 'VISA') return true;
    if (item.kind !== 'BUNDLE') return false;
    const bundleItems = (item.bundle as { items?: unknown } | null | undefined)?.items;
    return (
      Array.isArray(bundleItems) &&
      bundleItems.some((c) => (c as { kind?: unknown } | null)?.kind === 'VISA')
    );
  });
}

/**
 * 按整单「出发日」把导出订单精确过滤到 [travelFrom, travelTo]（闭区间，+8 日历日；
 * 口径与订单列表「出发日期」列一致，见文件头）。
 *
 * - travelFrom / travelTo 均未给（如勾选导出 / 整班导出已在别处短路）→ 原样返回（浅拷贝），不过滤；
 * - **无锚点的签证单保留**（见文件头「无锚点订单的口径」）——这是本函数与列表侧的唯一差别；
 *   无锚点且不涉签的单（空单/接送单/资料不全的机酒单）与列表侧一样剔除；
 * - 订单需带 `items`（含 `flightSchedule.departureTime`、`hotelCheckIn`、`visaIntendedDate`、
 *   `bundle.items`）—— 全岗总表 / 三模板的取数 include 均已联查，形状满足；
 *   类型上以内部 cast 收敛，调用方无需再断言。
 *
 * @param orders     已取回内存的订单数组（各带 id + items）
 * @param travelFrom 出发日期起（YYYY-MM-DD，含）
 * @param travelTo   出发日期止（YYYY-MM-DD，含）
 */
export function filterExportOrdersByDepartDate<T extends { id: string; items: unknown }>(
  orders: readonly T[],
  travelFrom?: string,
  travelTo?: string,
): T[] {
  if (!travelFrom && !travelTo) return [...orders];
  return orders.filter((o) => {
    const items = (o.items as ReadonlyArray<Record<string, unknown>>) ?? [];
    const departDate = deriveOrderDepartDate(items);
    // 无锚点 → 只有涉签单保留（导出口径；列表口径对无锚点单一律剔除）。
    // 不涉签的无锚点单（空单/接送单/资料不全的机酒单）没有「无处归日」这个理由，
    // 无条件保留会让它们出现在每一个指定日期的导出里。
    if (departDate === null) return orderHasVisaScope(items);
    if (travelFrom && departDate < travelFrom) return false;
    if (travelTo && departDate > travelTo) return false;
    return true;
  });
}
