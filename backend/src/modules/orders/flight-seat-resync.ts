/**
 * 机票行占座数「重对账」的纯函数层（换人 / 订正把出行人在婴儿 ↔ 占座乘客之间改来改去时用）。
 *
 * 背景（运营反馈）：换人或改生日把成人改成婴儿（或反过来）时，机位数不会自动加减。
 * 根因：占座数 `metadata.seatQuantity` 只在建单时按当时的乘客类型盖章一次
 *（见 flight-seat-quantity.ts），换人 / 订正只重派生 passengerType，既不重盖章、也不动
 * FlightSeatClass.sold —— 婴儿改成人后座位账少占一座（照旧能被别人卖掉），成人改婴儿则多占。
 *
 * 本模块只回答「每条机票行现在占几座、应该占几座、差几座」：
 *   · 应占 = resolveFlightSeatQuantity(quantity, 本单非婴儿人数)，与建单同一公式；
 *   · 现占 = flightSeatQuantity(行)（老行缺省回落 quantity）—— 与状态机放座分支同读，
 *     所以 Δ 施加到 sold 上之后，之后取消 / 改期按新盖章放座恰好对称；
 *   · 已起飞航段只重盖章不动账（与 isLegAlreadyFlown 口径一致：飞过的座位已被真实消耗）。
 * 事务内的占座 / 放座 / 盖章 / 审计由 orders.service 的 resyncFlightSeatsWithinTx 负责。
 *
 * 一个字都不动钱：unitPrice / amount / quantity / 乘客数校验一概不碰（理由见 flight-seat-quantity.ts）。
 * 也因此套餐机票腿（quantity 本就是 seatPax）在婴儿改成人时**加不上座**（应占被 quantity 夹住），
 * 这类行标 seatCappedByQuantity 进审计，要加座得由运营走套餐改档 / 改人数。
 */
import { PassengerType, type CabinClass } from '@prisma/client';
import {
  flightSeatQuantity,
  hasExplicitFlightSeatQuantity,
  resolveFlightSeatQuantity,
} from './flight-seat-quantity.js';
import { isTerminalLegItem, readJsonRecord } from './split-move-strategies.js';

/** 触发重对账的入口（审计 after.reason）：换人 / 订正出行人 / 存量清查脚本回填。 */
export type FlightSeatResyncReason = 'swap' | 'correct' | 'backfill';

/** 审计 targetLabel 用的入口中文名。 */
export const FLIGHT_SEAT_RESYNC_REASON_ZH: Record<FlightSeatResyncReason, string> = {
  swap: '换人',
  correct: '订正出行人',
  backfill: '存量清查回填',
};

export interface FlightSeatResyncRowInput {
  id: string;
  description: string;
  quantity: number;
  flightScheduleId: string | null;
  flightCabin: CabinClass | null;
  metadata: unknown;
  flightSchedule?: { departureTime: Date | null } | null;
}

export interface FlightSeatResyncRowPlan {
  itemId: string;
  description: string;
  scheduleId: string;
  cabin: CabinClass;
  quantity: number;
  /** 现占（flightSeatQuantity 口径，老行缺省 = quantity）。 */
  oldSeat: number;
  /** 应占（resolveFlightSeatQuantity 口径）。 */
  newSeat: number;
  /** newSeat − oldSeat：正 = 要再占，负 = 要放回。 */
  delta: number;
  /** 班次已起飞：只重盖章，不动 sold。 */
  departed: boolean;
  /** 套餐升舱拆座人数（与状态机同读 metadata.businessUpgradeCount）。 */
  businessUpgradeCount: number;
  hadExplicitSeatQuantity: boolean;
  /** 非婴儿人数超过 quantity（套餐腿）：座加不上，只能夹到 quantity。 */
  seatCappedByQuantity: boolean;
  /** 现有 metadata（重盖章时在它之上覆盖 seatQuantity / infantCount）。 */
  metadata: Record<string, unknown>;
  /** 这一行需要写库吗（Δ≠0，或盖章缺省 / 与应占不一致）。 */
  needsWrite: boolean;
}

export interface FlightSeatResyncPlan {
  passengerCount: number;
  infantCount: number;
  nonInfantPax: number;
  rows: FlightSeatResyncRowPlan[];
  /** 任一行需要写库 → 本次要落盖章 / 座位账 / 审计；否则什么都不做。 */
  changed: boolean;
}

/** 乘客类型改动是否跨过「婴儿 ↔ 占座乘客（成人 / 儿童）」边界：成人 ↔ 儿童不动座位。 */
export function isInfantBoundaryCrossed(
  before: PassengerType | null | undefined,
  after: PassengerType | null | undefined,
): boolean {
  const wasInfant = before === PassengerType.INFANT;
  const isInfant = (after ?? before) === PassengerType.INFANT;
  return wasInfant !== isInfant;
}

function readUpgradeCount(meta: Record<string, unknown>): number {
  const raw = meta.businessUpgradeCount;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

function readInfantCountStamp(meta: Record<string, unknown>): number | null {
  const raw = meta.infantCount;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : null;
}

/**
 * 按本单**当前**乘客类型给每条活机票行算「现占 / 应占 / Δ」。
 *
 * 只看活航段：有班次、有舱位、且不是取消航段 / 回程作废的留痕残骸（那些行座位早还回去了，
 * 班次也已置空，这里双重排除）。
 */
export function planFlightSeatResync(
  rows: ReadonlyArray<FlightSeatResyncRowInput>,
  passengers: ReadonlyArray<{ passengerType: PassengerType | null }>,
  nowMs: number,
): FlightSeatResyncPlan {
  const passengerCount = passengers.length;
  const infantCount = passengers.filter((p) => p.passengerType === PassengerType.INFANT).length;
  const nonInfantPax = Math.max(0, passengerCount - infantCount);

  const plans: FlightSeatResyncRowPlan[] = [];
  for (const row of rows) {
    if (!row.flightScheduleId || !row.flightCabin) continue;
    const metadata = readJsonRecord(row.metadata);
    if (isTerminalLegItem(metadata)) continue;
    const quantity = Math.max(0, Math.trunc(row.quantity));
    const oldSeat = flightSeatQuantity({ quantity, metadata });
    const newSeat = resolveFlightSeatQuantity(quantity, nonInfantPax);
    const hadExplicit = hasExplicitFlightSeatQuantity({ quantity, metadata });
    const departureTime = row.flightSchedule?.departureTime ?? null;
    // 与 orders.service 的 isLegAlreadyFlown 同一口径：departureTime 是真 UTC 瞬间，直接比。
    const departed = departureTime != null && departureTime.getTime() <= nowMs;
    const delta = newSeat - oldSeat;
    const stampStale =
      !hadExplicit || oldSeat !== newSeat || readInfantCountStamp(metadata) !== infantCount;
    plans.push({
      itemId: row.id,
      description: row.description,
      scheduleId: row.flightScheduleId,
      cabin: row.flightCabin,
      quantity,
      oldSeat,
      newSeat,
      delta,
      departed,
      businessUpgradeCount: readUpgradeCount(metadata),
      hadExplicitSeatQuantity: hadExplicit,
      seatCappedByQuantity: nonInfantPax > quantity,
      metadata,
      needsWrite: delta !== 0 || stampStale,
    });
  }

  return {
    passengerCount,
    infantCount,
    nonInfantPax,
    rows: plans,
    changed: plans.some((p) => p.needsWrite),
  };
}

/**
 * 余票不足时给经办人看的文案（代理与运营同一句，不给超售开关）。
 * 婴儿改成成人 / 儿童都要占座，所以写「成人/儿童」而不是只写成人。
 */
export function flightSeatResyncShortageMessage(input: {
  description: string;
  cabinLabel: string;
  need: number;
}): string {
  return (
    `出行人改为成人/儿童后需再占 ${input.need} 个机位，` +
    `该班次（${input.description} · ${input.cabinLabel}）已售罄，请先改期或提交改单申请`
  );
}
