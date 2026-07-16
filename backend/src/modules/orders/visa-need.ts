/**
 * 「本单要不要我方代办签证」——单一判定口径。
 *
 * 拍板口径：**本单存在至少一位需要我方代办签证的乘客**。
 *
 * 背景：「要不要办签证」散在三根轴上，各处自行手抄组合，口径容易漂：
 *   1. 订单级 —— Order.visaStatus = NEEDED / E_VISA（电子签同样要送签，签证台按类型筛）
 *   2. 商品级 —— 含 VISA 订单项，或含 VISA 组件的套餐
 *   3. 乘客级 —— Passenger.visaExempt（客人自备签证，无需送签）
 *
 * 前两根轴回答「这单涉不涉及签证」，第三根轴回答「到底还有没有人要我们办」。
 * 三根轴必须一起看：签证台按 `visaExempt: false` 过滤乘客展示，因此若只看前两根轴建任务，
 * 全员自备签的单会生成一条「点进去零乘客」的空任务，占着签证岗的看板却无事可做。
 *
 * 本模块只做纯判定，不碰 Prisma —— 调用方把三根轴的数据取好传进来，便于单测穷举组合。
 */
import { VisaRequirement } from '@prisma/client';

/** 乘客级：该乘客要不要我方代办签证。visaExempt=true → 客人自备签，不用我们办。 */
export function passengerNeedsVisa(passenger: { visaExempt?: boolean | null }): boolean {
  return passenger.visaExempt !== true;
}

/**
 * 乘客级汇总：本单还有没有人要我方代办签证。
 *
 * 注意空名单的口径：**没录乘客 ≠ 没人要办**（录单可以先建单、后补乘客）。
 * 「查无乘客」证明不了「无人需要」，此时回落 true，把判断权留给前两根轴——
 * 宁可多建一条任务让签证岗看见，也不要静默漏单。
 */
export function anyPassengerNeedsVisa(
  passengers: ReadonlyArray<{ visaExempt?: boolean | null }>,
): boolean {
  if (passengers.length === 0) return true;
  return passengers.some(passengerNeedsVisa);
}

/** 订单级：visaStatus 是否表示本单需要送签。电子签（E_VISA）同样要送签。 */
export function orderVisaStatusRequiresVisa(
  visaStatus: VisaRequirement | null | undefined,
): boolean {
  return visaStatus === VisaRequirement.NEEDED || visaStatus === VisaRequirement.E_VISA;
}

/**
 * 本单要不要建签证任务 —— 三根轴收口在这一处。
 *
 * `hasVisaScope` = 商品级是否涉及签证（含 VISA 订单项 / 含签证组件的套餐）；
 * 由调用方按各自已有的锚点逻辑算出后传入。
 *
 * 判定：（订单级需签 或 商品级涉签） 且 至少一位乘客要我方代办。
 */
export function orderNeedsVisaTask(input: {
  visaStatus?: VisaRequirement | null;
  hasVisaScope?: boolean;
  passengers: ReadonlyArray<{ visaExempt?: boolean | null }>;
}): boolean {
  const inScope = orderVisaStatusRequiresVisa(input.visaStatus) || input.hasVisaScope === true;
  if (!inScope) return false;
  return anyPassengerNeedsVisa(input.passengers);
}
