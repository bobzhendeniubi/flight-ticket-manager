/**
 * 「以此单为模板」的预填映射 —— 订单 → 录单弹窗初始值（纯函数，无 React）。
 *
 * 用途：同一家代理、同一个联系人、同一套备注口径的单子经常一天录好几张，
 * 运营现在得把这些字段一遍遍重敲。这里把一张既有订单折成录单弹窗的初始值。
 *
 * 带什么、不带什么（这条界线是刻意的）：
 *   带 —— 产品**类型**（套餐单再带套餐 id）、归属代理、联系人三项、订单签证状态、
 *         通用备注 + 四类分岗备注（酒店 / 签证 / 付款 / 特殊要求）。
 *   不带 —— 出行人（换一批人是新单的全部意义）、日期与班次 / 房型（下一单的行程本来就不同，
 *         照搬只会让人以为选好了）、金额（调价、结算价、已收款一律不继承，
 *         金额必须逐单重新决定，绝不能被上一单静默带过来）。
 */
import type { OrderItemKind, OrderSummary, VisaStatusInput } from '../lib/api';
import type { ProductBlockKind } from './SingleOrderProductBlock';

export interface SingleOrderPrefill {
  /** 产品区块类型，顺序即区块顺序；套餐单恒为 ['BUNDLE']（套餐独占一张单）。 */
  blockKinds: ProductBlockKind[];
  /** 套餐单的套餐 id；非套餐单为空串。 */
  bundleId: string;
  /** 机票区块是单程还是往返（源单有两条以上机票行即视作往返）。 */
  flightTripType: 'ONEWAY' | 'ROUNDTRIP';
  /** 归属代理；空串 = 直客。 */
  agentId: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  notes: string;
  noteHotel: string;
  noteVisa: string;
  notePayment: string;
  noteSpecial: string;
  /** 订单级签证状态；null = 源单没记，交给弹窗按产品派生默认值。 */
  visaStatus: VisaStatusInput | null;
}

/** 订单行类型 → 录单区块类型；不是「可录的产品」的行（调价 / 折扣 / 保险等）不映射。 */
const ITEM_KIND_TO_BLOCK: Partial<Record<OrderItemKind, ProductBlockKind>> = {
  FLIGHT: 'FLIGHT',
  HOTEL: 'HOTEL',
  VISA: 'VISA',
  TRANSFER: 'TRANSFER',
  BUNDLE: 'BUNDLE',
};

function text(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 从订单行推出产品区块类型。
 *   · 含套餐行 → 只有一个 BUNDLE 区块（套餐独占一张订单，与录单弹窗的不变式一致）；
 *   · 否则按行出现顺序取**去重**后的类型：往返两条机票行合成一个机票区块
 *     （区块内部用 tripType 表达往返），同类型多条也只给一个区块 ——
 *     模板只负责把类型摆好，真要几条由运营在弹窗里加。
 *   · 一条可录产品行都没有（纯调价单等）→ 空数组，调用方回落到默认区块。
 */
function deriveBlockKinds(order: OrderSummary): ProductBlockKind[] {
  const items = order.items ?? [];
  if (items.some((it) => it.kind === 'BUNDLE')) return ['BUNDLE'];
  const kinds: ProductBlockKind[] = [];
  for (const it of items) {
    const mapped = ITEM_KIND_TO_BLOCK[it.kind];
    if (mapped && mapped !== 'BUNDLE' && !kinds.includes(mapped)) kinds.push(mapped);
  }
  return kinds;
}

export function buildSingleOrderPrefill(order: OrderSummary): SingleOrderPrefill {
  const items = order.items ?? [];
  const blockKinds = deriveBlockKinds(order);
  const bundleItem = items.find((it) => it.kind === 'BUNDLE');
  const flightLegs = items.filter((it) => it.kind === 'FLIGHT').length;

  return {
    blockKinds,
    bundleId: text(bundleItem?.bundleId),
    // 套餐单的机票腿由套餐自己派生，这里只表达「独立机票区块」的往返与否
    flightTripType: blockKinds.includes('FLIGHT') && flightLegs >= 2 ? 'ROUNDTRIP' : 'ONEWAY',
    agentId: text(order.agentId),
    contactName: text(order.contactName),
    contactPhone: text(order.contactPhone),
    contactEmail: text(order.contactEmail),
    notes: text(order.notes),
    noteHotel: text(order.noteHotel),
    noteVisa: text(order.noteVisa),
    notePayment: text(order.notePayment),
    noteSpecial: text(order.noteSpecial),
    visaStatus: order.visaStatus ?? null,
  };
}
