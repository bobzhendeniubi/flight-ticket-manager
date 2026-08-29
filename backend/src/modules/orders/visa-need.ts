/**
 * 「本单要不要我方代办签证」——单一判定口径。
 *
 * 拍板口径：**本单存在至少一位需要我方代办签证的乘客**。
 *
 * 背景：「要不要办签证」散在三根轴上，各处自行手抄组合，口径容易漂：
 *   1. 订单级 —— Order.visaStatus = NEEDED / E_VISA（电子签同样要送签，签证台按类型筛）；
 *      反向的 NOT_NEEDED 是**一票否决**，压过下面两根轴（录单人已经明说这单不用我们办）
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
 * 订单级「明确不需要我方代办」—— 录单时显式选了「不需要签证」。
 *
 * 与 `visaStatus = null`（没表态）区别对待：没表态时商品级涉签照常建任务（不漏单）；
 * 显式选了「不需要」是录单人给出的结论，压过商品级涉签（见 orderNeedsVisaTask）。
 */
export function orderVisaStatusExplicitlyNotNeeded(
  visaStatus: VisaRequirement | null | undefined,
): boolean {
  return visaStatus === VisaRequirement.NOT_NEEDED;
}

/**
 * 本单要不要建签证任务 —— 三根轴收口在这一处。
 *
 * `hasVisaScope` = 商品级是否涉及签证（含 VISA 订单项 / 含签证组件的套餐）；
 * 由调用方按各自已有的锚点逻辑算出后传入。
 *
 * 判定：订单级明确「不需要」→ 直接否决；否则（订单级需签 或 商品级涉签）且至少一位乘客要我方代办。
 *
 * 订单级「不需要」为什么压过商品级涉签：含签证组件的套餐 hasVisaScope 恒为 true，不压的话
 * 录单选了「不需要签证」的单照样建任务，签证台上挂一条办不掉的「待处理」。此前只靠录单弹窗
 * 的前端联动（选「不需要」时把出行人批量置自备签）消掉商品级这根轴，但联动只在下拉 onChange
 * 那一瞬生效：先把签证状态改成「不需要」、再挑具体套餐（签证列此时才出现），联动整条错过，
 * 任务照建。判定收在这里之后，「不需要签证」不再依赖任何前端时序。
 *
 * 只认 NOT_NEEDED，不含 HAS_VISA（已签证）：后者语义上也无需送签，但改动面更大，留待拍板。
 * 乘客级 visaExempt 一概不碰 —— 它同时是**定价**输入（套餐按人扣减自备签减免、签证组件按
 * 办签人数计费），服务端替客人勾自备签 = 静默改价。
 */
export function orderNeedsVisaTask(input: {
  visaStatus?: VisaRequirement | null;
  hasVisaScope?: boolean;
  passengers: ReadonlyArray<{ visaExempt?: boolean | null }>;
}): boolean {
  if (orderVisaStatusExplicitlyNotNeeded(input.visaStatus)) return false;
  const inScope = orderVisaStatusRequiresVisa(input.visaStatus) || input.hasVisaScope === true;
  if (!inScope) return false;
  return anyPassengerNeedsVisa(input.passengers);
}
