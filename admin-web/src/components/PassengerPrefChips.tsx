/**
 * 备注结构化的只读小徽标（列表乘客子行 / 详情乘客卡片 / 订单内容列共用一份）。
 *
 * 这几项原本写在自由备注里，下游（分房、房控、票务）全靠人眼在备注里找：
 *   · 乘客级：床型（大床 / 双床）、兑换升舱（去程 / 回程 / 往返，说明进悬浮）
 *   · 订单级：单独编码出票、同酒店安排
 * 样式沿用相邻的「单住 / 自备签」chip（同尺寸同圆角同 ring），只换配色区分语义：
 * 床型=青、兑换=紫、单独编码=品牌靛蓝、同酒店=翠绿。缺省/未知值一律不渲染，不占位。
 */

import type { UpgradeRedeemLeg } from '../lib/api';

// 标签表用 Map：这些值来自后端 / 老数据，不是受控枚举。用普通对象查表时，
// 'constructor'、'toString' 这类原型链上的键会查出函数并被渲染成 chip 文字。
/** 床型枚举 → 中文标签。历史遗留值（SINGLE / SHARE_OK）不在表内 → 不出 chip。 */
const BED_PREF_LABEL = new Map<string, string>([
  ['DOUBLE', '大床'],
  ['TWIN', '双床'],
]);

/** 兑换升舱航段 → 中文标签。NONE 不在表内 → 不出 chip。 */
const UPGRADE_REDEEM_LEG_LABEL = new Map<string, string>([
  ['OUTBOUND', '去程'],
  ['RETURN', '回程'],
  ['BOTH', '往返'],
]);

/** 床型中文标签；不限 / 历史遗留值 / 表外任何字符串返回 null（调用方据此不渲染）。 */
export function bedPrefLabel(value: string | null | undefined): string | null {
  return value ? (BED_PREF_LABEL.get(value) ?? null) : null;
}

/** 兑换升舱中文标签；NONE / 缺省 / 表外任何字符串返回 null（调用方据此不渲染）。 */
export function upgradeRedeemLegLabel(value: string | null | undefined): string | null {
  return value ? (UPGRADE_REDEEM_LEG_LABEL.get(value) ?? null) : null;
}

/** 录入口径下拉选项（录单 / 批量 / 纠错弹窗共用，保证三处口径一字不差）。 */
export const BED_PREF_OPTIONS: ReadonlyArray<{ value: '' | 'DOUBLE' | 'TWIN'; label: string }> = [
  { value: '', label: '不限' },
  { value: 'DOUBLE', label: '大床' },
  { value: 'TWIN', label: '双床' },
];

export const UPGRADE_REDEEM_LEG_OPTIONS: ReadonlyArray<{ value: UpgradeRedeemLeg; label: string }> = [
  { value: 'NONE', label: '不兑换' },
  { value: 'OUTBOUND', label: '去程' },
  { value: 'RETURN', label: '回程' },
  { value: 'BOTH', label: '往返' },
];

/** chip 基类：与相邻的「单住 / 自备签」完全同款，只有配色由各处传入。 */
const CHIP_BASE = 'rounded px-1.5 py-0.5 text-[10px] font-medium ring-1';

export interface PassengerPrefChipsProps {
  bedPref?: string | null;
  upgradeRedeemLeg?: string | null;
  upgradeRedeemNote?: string | null;
  /** 详情乘客卡片里徽标是行内接排的，需要左外边距；列表子行用 flex gap，不需要。 */
  inline?: boolean;
}

/** 乘客级徽标：床型 + 兑换升舱。两项都没有时整体不渲染（返回 null，不留空白）。 */
export function PassengerPrefChips({
  bedPref,
  upgradeRedeemLeg,
  upgradeRedeemNote,
  inline = false,
}: PassengerPrefChipsProps) {
  const bed = bedPrefLabel(bedPref);
  const leg = upgradeRedeemLegLabel(upgradeRedeemLeg);
  if (!bed && !leg) return null;
  const spacing = inline ? 'ml-2 ' : '';
  const note = upgradeRedeemNote?.trim();
  return (
    <>
      {bed && (
        <span className={`${spacing}${CHIP_BASE} bg-teal-50 text-teal-700 ring-teal-200`} title="床型">
          {bed}
        </span>
      )}
      {leg && (
        <span
          className={`${spacing}${CHIP_BASE} bg-violet-50 text-violet-700 ring-violet-200`}
          title={note ? `兑换升舱 · ${note}` : '兑换升舱（用常旅客次数换商务舱）'}
        >
          兑换·{leg}
        </span>
      )}
    </>
  );
}

export interface OrderNoteFlagChipsProps {
  separatePnr?: boolean | null;
  sameHotelWith?: string | null;
  /** 行内接排时加左外边距（同 PassengerPrefChips）。 */
  inline?: boolean;
}

/** 订单级徽标：单独编码 + 同酒店安排。都没有时整体不渲染。 */
export function OrderNoteFlagChips({ separatePnr, sameHotelWith, inline = false }: OrderNoteFlagChipsProps) {
  const sameHotel = sameHotelWith?.trim() || '';
  if (!separatePnr && !sameHotel) return null;
  const spacing = inline ? 'ml-2 ' : '';
  return (
    <>
      {separatePnr && (
        <span
          className={`${spacing}${CHIP_BASE} bg-brand-50 text-brand-700 ring-brand-200`}
          title="本单乘客单独编码出票，不与他单合并 PNR"
        >
          单独编码
        </span>
      )}
      {sameHotel && (
        <span
          className={`${spacing}${CHIP_BASE} inline-block max-w-[14rem] truncate align-bottom bg-emerald-50 text-emerald-700 ring-emerald-200`}
          title={`同酒店安排：${sameHotel}`}
        >
          同酒店：{sameHotel}
        </span>
      )}
    </>
  );
}
