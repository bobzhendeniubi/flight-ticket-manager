// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import { CabinClass } from '@prisma/client';
import { AppError, BadRequestError } from '../../../lib/errors.js';
import { canonicalJson } from '../../../lib/canonical-json.js';
import type { CancelLegBody } from '../orders.schemas.js';

/**
 * 释放/恢复的座位明细（放几座恢复几座的唯一依据）。
 * 写成 type 而非 interface：它要作为 metadata 快照的一部分赋给 Prisma.InputJsonValue，
 * 只有类型别名才拿得到隐式索引签名（interface 拿不到，会编译不过）。
 */
export type ReleasedSeatEntry = {
  scheduleId: string;
  cabin: CabinClass;
  quantity: number;
};

/**
 * 回程行 metadata.returnReleased 的快照形状（防御式读，字段都可能缺）。
 * `returnVoidedFinal` 由「回程起飞后自动作废」的后续 job 补写在**同级 metadata** 上，
 * 恢复端点见到即拒绝 —— 本版不实现那个 job，但结构位置先钉死，届时零迁移接入。
 */
export interface ReturnReleasedSnapshot {
  at?: string;
  byUserId?: string;
  requestToken?: string;
  reason?: string;
  originalDescription?: string;
  originalScheduleId?: string | null;
  originalCabin?: CabinClass | null;
  releasedSeats?: ReleasedSeatEntry[];
  ticketedAtRelease?: number;
  /** 释放当时回程是否为「已开票」态（释放会把它清成未开，恢复不自动翻回；老快照缺省 undefined）。 */
  returnInvoicedAtRelease?: boolean;
  workOrderReminderId?: string | null;
  note?: string | null;
}

/**
 * 航段动作类型（legActionLog 条目的 type）。
 * 每个端点只接受属于自己的那几种：no-show 端点接 NO_SHOW/RELEASE，恢复只接 RESTORE，
 * 取消航段只接 CANCEL_LEG，起飞后作废只接 VOID，按人改期的全员快路径只接
 * RESCHEDULE_ALL —— 跨动作复用同一个 token 一律拒。
 */
export type LegActionType =
  | 'NO_SHOW'
  | 'RELEASE'
  | 'RESTORE'
  | 'CANCEL_LEG'
  | 'VOID'
  | 'RESCHEDULE_ALL';

/**
 * 一条航段动作流水（no-show / 再释放 / 恢复 / 取消航段 / 作废各一条）。
 * 幂等回放认的就是这里的 requestToken —— 见下方 collectLegActionEntries 的注释。
 */
export type LegActionLogEntry = {
  type: LegActionType;
  requestToken: string;
  at: string;
  byUserId: string;
  /** 本次动了几座（释放 / 恢复才有）。 */
  seats?: number;
  /** 本次恢复是否超售（RESTORE 才有）。 */
  oversold?: boolean;
  /**
   * 本次**新增**的超售座数（RESTORE 才有）。
   * 只记布尔的 oversold 说不出量：同一行释放→恢复→再释放→再恢复反复几轮，
   * 快照 returnRestored 是覆盖写，只留得下最后一轮 —— 报表按快照统计会漏掉中间几轮的超售。
   */
  oversoldBy?: number;
  /** 本次挤掉了几座他人软预留（他人 ACTIVE 锁位 + 占位单余座；RESTORE 才有）。 */
  displacedReserved?: number;
  /**
   * 本次动作的关键入参指纹（见 legActionFingerprint）。
   * 回放时逐字比对：同一个 token 换一份请求体再发一次，指纹对不上就拒，绝不静默按上一次的入参回成功。
   */
  fingerprint?: string;
};

/**
 * 关键入参 → 稳定指纹字符串（键排序后 JSON），回放比对用。
 *
 * 只放**会改变落库结果**的字段：
 *   · no-show    { releaseReturn, passengerIds(去重排序) } —— 决定放不放座、给谁打标；
 *   · 取消航段    { leg, feeMode, manualRefundCny, manualFeeCny, overrideReason } —— 决定放哪一段、
 *                 退多少钱（manualRefundCny 与老字段 manualFeeCny 都入指纹，换任一个都会指纹不符）；
 *   · 恢复回程    {} —— 恢复目标（班次/座数）只由释放快照决定，请求体里没有一个字段能改结果，
 *                 allowOversell 只是「没座时要不要继续」的确认位，刻意不入指纹；
 *   · 起飞后作废  {} —— 同上，只有 note。
 * note 一律不入指纹：它是给人看的备注，改了备注不该把一次正当的重试拦成 409。
 */
export function legActionFingerprint(payload: Record<string, unknown>): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value != null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) out[key] = normalize(obj[key]);
      return out;
    }
    return value === undefined ? null : value;
  };
  return JSON.stringify(normalize(payload));
}

/** no-show / 再释放的入参指纹（决定放不放座、给谁打标）。 */
export function noShowFingerprint(input: { releaseReturn: boolean; passengerIds?: string[] }): string {
  return legActionFingerprint({
    releaseReturn: input.releaseReturn,
    passengerIds: [...new Set(input.passengerIds ?? [])].sort(),
  });
}

/**
 * 取消航段的入参指纹（决定放哪一段、退多少钱、凭什么覆盖政策）。
 *
 * manualRefundCny 与老字段 manualFeeCny 都入指纹（各自原样入，不做互相换算）：
 * 同一个 token 换任一个字段的值重放都必须指纹不符，绝不能靠「反正最后算出来的钱一样」
 * 就放行——那等于允许运营用老字段悄悄绕过新字段的校验路径再重放一次。
 */
export function cancelLegFingerprint(input: CancelLegBody): string {
  return legActionFingerprint({
    leg: input.leg,
    feeMode: input.feeMode,
    manualRefundCny:
      input.feeMode === 'MANUAL' && input.manualRefundCny != null
        ? Math.trunc(input.manualRefundCny)
        : null,
    manualFeeCny: input.feeMode === 'MANUAL' ? Math.trunc(input.manualFeeCny ?? 0) : null,
    overrideReason: input.overrideReason?.trim() || null,
  });
}

/**
 * 按人改期「全员快路径」的入参指纹（决定改哪一行、改到哪、收多少差价）。
 *
 * 这条路径不拆单，直接落到整单改期上 —— 座位真搬、差价真记，重复执行就是重复计费，
 * 所以幂等只能靠 token 绑定：同一个 requestToken 命中且指纹一致才回放，对不上一律 409。
 * feeLabel / note 不入指纹（只影响留痕文案，改个备注重试不该被拦成 409）。
 */
export function rescheduleAllFingerprint(input: {
  orderItemId?: string;
  newScheduleId: string;
  newCabin?: CabinClass;
  feeCny?: number;
}): string {
  return legActionFingerprint({
    orderItemId: input.orderItemId ?? null,
    newScheduleId: input.newScheduleId,
    newCabin: input.newCabin ?? null,
    feeCny: Math.trunc(input.feeCny ?? 0),
  });
}

/** 恢复回程 / 起飞后作废的入参指纹：请求体里没有能改变结果的字段，恒为空对象。 */
export const EMPTY_LEG_ACTION_FINGERPRINT = legActionFingerprint({});

/** 防御式读一行 metadata 上的 legActionLog（形状不符 / 缺 token 的条目直接丢弃）。 */
export function readLegActionLog(metadata: unknown): LegActionLogEntry[] {
  const raw = readJsonObject(metadata).legActionLog;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is LegActionLogEntry =>
      e != null &&
      typeof e === 'object' &&
      !Array.isArray(e) &&
      typeof (e as { requestToken?: unknown }).requestToken === 'string' &&
      (e as { requestToken: string }).requestToken !== '',
  );
}

/** 老数据里的快照键 → 动作类型（那批行没有 legActionLog，只能按快照位置反推）。 */
export const LEG_SNAPSHOT_ACTION_TYPE: ReadonlyArray<[string, LegActionType]> = [
  ['noShow', 'NO_SHOW'],
  ['returnReleased', 'RELEASE'],
  ['returnRestored', 'RESTORE'],
  ['returnLegCancelled', 'CANCEL_LEG'],
  ['returnVoidedFinal', 'VOID'],
];

/** 「这个 token 见过没有、是哪种动作、当初的入参指纹是什么」。 */
export type LegActionTokenLookup = {
  /** 这张单的任一航段行见过这个 token（= 本次请求是重试）。 */
  seen: boolean;
  /** 当初那次是什么动作；老快照只能按快照位置反推，反推不出为 null。 */
  type: LegActionType | null;
  /** 当初那次的入参指纹；老数据没有 → null（回放一律 fail-closed）。 */
  fingerprint: string | null;
};

/**
 * 该行见过的**全部** requestToken 及其动作类型 / 入参指纹（幂等回放的唯一依据）。
 *
 * 为什么不能只查「当前快照上的 token」：释放 → 恢复 → 再释放 → 再恢复可以反复发生，
 * returnReleased / returnRestored 每次都会被新快照覆盖（旧的压进 history 或直接被顶掉），
 * 于是**中间几轮的 token 就再也扫不到了** —— 那几轮的延迟重试会绕过回放，二次放座 / 二次占座，
 * 座位账凭空多算或少算一批，事后极难查。
 *
 * 现在每次动作都往行上的 legActionLog 追加一条（append-only，永不覆盖），条目里带着**动作类型**
 * 与**入参指纹**。集合同时兜住老数据：本次改动之前落库的行没有 legActionLog，token 只存在于
 * 当前快照与各自的 history 里，一并扫进来（类型按快照位置反推，指纹一律 null）。
 */
export function collectLegActionEntries(metadata: unknown): Map<string, LegActionTokenLookup> {
  const out = new Map<string, LegActionTokenLookup>();
  const push = (token: unknown, type: LegActionType | null, fingerprint: unknown): void => {
    if (typeof token !== 'string' || token === '') return;
    // 同一个 token 若两处都留了痕，以带指纹的那条为准（流水比快照更权威）。
    const prior = out.get(token);
    if (prior?.fingerprint != null) return;
    out.set(token, {
      seen: true,
      type,
      fingerprint: typeof fingerprint === 'string' && fingerprint !== '' ? fingerprint : null,
    });
  };
  for (const entry of readLegActionLog(metadata)) {
    push(entry.requestToken, entry.type ?? null, entry.fingerprint);
  }
  const meta = readJsonObject(metadata);
  for (const [key, type] of LEG_SNAPSHOT_ACTION_TYPE) {
    const snap = readJsonObject(meta[key]);
    push(snap.requestToken, type, null);
    for (const history of [snap.history, snap.releaseHistory]) {
      if (!Array.isArray(history)) continue;
      for (const item of history) push(readJsonObject(item).requestToken, type, null);
    }
  }
  return out;
}

/** 这张单的任一航段行见过这个 token 吗（连同当初的动作类型与入参指纹一起回）。 */
export function hasSeenLegActionToken(
  rows: ReadonlyArray<{ metadata: unknown }>,
  requestToken: string,
): LegActionTokenLookup {
  let fallback: LegActionTokenLookup | null = null;
  for (const row of rows) {
    const hit = collectLegActionEntries(row.metadata).get(requestToken);
    if (!hit) continue;
    if (hit.fingerprint != null) return hit;
    fallback = fallback ?? hit;
  }
  return fallback ?? { seen: false, type: null, fingerprint: null };
}

/**
 * 回放前的守闸：动作类型与入参指纹都要对得上，否则 409。
 *
 * 两类不一致各自会造成什么：
 *   · **类型不一致** —— 同一个 token 先用来取消航段、又拿去标 no-show：按 token 命中就回放，
 *     运营会看到「no-show 成功」而实际上什么都没发生（座位早按取消政策放掉、钱也已经结过）。
 *   · **指纹不一致** —— 同 token 换一份请求体重发（弹窗里改了「同时释放回程」的勾选又点重试）：
 *     回放照样回成功，运营以为这次的勾选生效了，实际座位早按上一次的勾选处置完了。
 *
 * 老数据（本次改动之前落库的行）没有指纹，一律 **fail-closed**：宁可让运营换个新请求编号
 * 重新预检一遍，也不能凭「读不出来」就按老入参回一个成功。
 */
export function assertLegActionTokenReplay(
  lookup: LegActionTokenLookup,
  accepts: readonly LegActionType[],
  fingerprint: string,
): void {
  if (lookup.type == null || !accepts.includes(lookup.type)) {
    throw tokenPayloadMismatchError(
      { reason: 'ACTION_TYPE', priorType: lookup.type, expectedTypes: [...accepts] },
      '这个请求编号已经用在另一种航段操作上了，请重新预检并用新的请求编号提交。',
    );
  }
  if (lookup.fingerprint == null) {
    throw tokenPayloadMismatchError(
      { reason: 'LEGACY_SNAPSHOT', priorType: lookup.type },
      '这个请求编号的历史留痕里没有入参记录，无法确认与本次是同一个请求；' +
        '请重新预检并用新的请求编号提交。',
    );
  }
  if (lookup.fingerprint !== fingerprint) {
    throw tokenPayloadMismatchError({
      reason: 'PAYLOAD',
      priorType: lookup.type,
      priorFingerprint: lookup.fingerprint,
      currentFingerprint: fingerprint,
    });
  }
}

/** 往行 metadata 追加一条动作流水，返回新的 legActionLog 数组（原数组不改）。 */
export function appendLegActionLog(metadata: unknown, entry: LegActionLogEntry): LegActionLogEntry[] {
  return [...readLegActionLog(metadata), entry];
}

/** 按人改期编排入参指纹里归一化后的 roomSplit 行。 */
export type OrchestrationRoomSplitRow = { itemId: string; roomsBilledToMove: number };

/** 拆单流水 snapshot.orchestration 的形状（落库与回放比对共用同一个类型）。 */
export type SplitOrchestrationSnapshot = Record<
  string,
  string | number | null | OrchestrationRoomSplitRow[]
>;

/**
 * orchestration 里**不参与指纹比对**的键：不是请求入参，是首刷时算出来留给回放用的派生值。
 * 拿它们比对等于要求「回放前先把这个值算出来」—— 而回放要解决的恰恰是算不出来。
 */
export const ORCHESTRATION_DERIVED_KEYS: readonly string[] = ['leg'];

/** 编排入参指纹：剔掉派生记录后按键序无关序列化。 */
export function orchestrationFingerprint(snapshot: Record<string, unknown>): string {
  const inputsOnly: Record<string, unknown> = { ...snapshot };
  for (const key of ORCHESTRATION_DERIVED_KEYS) delete inputsOnly[key];
  return canonicalJson(inputsOnly);
}

/** 从留档的 orchestration 里读回首刷派生的航段（读不出合法值就当没留）。 */
export function readOrchestrationLeg(value: unknown): 'OUTBOUND' | 'RETURN' | null {
  return value === 'OUTBOUND' || value === 'RETURN' ? value : null;
}

/**
 * 按人改期的编排入参指纹（拆单流水 snapshot.orchestration 的唯一构造口径）。
 *
 * 落库与比对必须走同一个函数、同一个键序 —— 两处各写一份对象字面量，
 * 早晚会因为键序或缺省值不同而把「同一个请求」判成不一致，运营侧表现为莫名其妙的 409。
 *
 * **进指纹的是「会改变结果的入参」**：
 *   · orderItemId / newScheduleId / newCabin / feeCny —— 改哪一段、改到哪、收多少差价。
 *   · roomSplit —— 每张酒店行搬几间房，直接决定两侧订单的金额与房控占用；同 token 换一份
 *     房数重发，若不比对就会静默回放上一轮的拆法，运营以为新的房数生效了。
 *     行序不是语义（前端按弹窗行序发），这里统一按 itemId 升序、房数转 number 后再落；
 *     不传 = null，与「传了空数组」区分开。
 *
 * **不进指纹的**：feeLabel / note —— 只影响留痕文案，不改变座位、金额、房控任何结果。
 * 把它们纳进来只会让运营改个备注重试就吃 409。
 *
 * `leg` 是**派生记录**而不是入参：它由 orderItemId 在源单上推出来，留档只为了回放时
 * 源单已无该行还能定位航段（见 ORCHESTRATION_DERIVED_KEYS），因此不参与指纹比对。
 */
export function reschedulePassengersOrchestration(
  input: {
    orderItemId: string;
    newScheduleId: string;
    newCabin?: CabinClass;
    feeCny?: number;
    roomSplit?: Array<{ itemId: string; roomsBilledToMove: number }>;
  },
  leg: 'OUTBOUND' | 'RETURN' | null,
): SplitOrchestrationSnapshot {
  return {
    orderItemId: input.orderItemId,
    newScheduleId: input.newScheduleId,
    newCabin: input.newCabin ?? null,
    feeCny: Math.trunc(input.feeCny ?? 0),
    leg,
    roomSplit:
      input.roomSplit == null
        ? null
        : [...input.roomSplit]
            .map((row) => ({
              itemId: row.itemId,
              roomsBilledToMove: Number(row.roomsBilledToMove),
            }))
            .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)),
  };
}

/** 幂等回放时入参与首刷对不上 —— 稳定 code，前端据此提示换新请求编号重试。 */
export function tokenPayloadMismatchError(
  detail: Record<string, unknown>,
  message = '这个请求编号已用于另一次操作，请刷新后重试。',
): AppError {
  return new AppError(message, {
    statusCode: 409,
    code: 'TOKEN_PAYLOAD_MISMATCH',
    details: detail,
  });
}

/**
 * 改期的幂等键在**订单行锁内**被判定为「已经用过」时的 409。
 *
 * 与 TOKEN_PAYLOAD_MISMATCH 分开是因为成因不同：那个是「同编号换了一份入参」（请求本身有问题），
 * 这个是「同编号的另一次提交正好在并发执行、并且先一步提交了」（请求没问题，只是撞车了）。
 * 客户端刷新后原样重发即可 —— 那时首刷已提交，编排层的回放分支会正常返回成功。
 */
export function rescheduleTokenInFlightError(requestToken: string): AppError {
  return new AppError('这个请求编号刚刚已经被另一次提交用掉了，请刷新订单确认改期结果后再操作。', {
    statusCode: 409,
    code: 'RESCHEDULE_TOKEN_IN_FLIGHT',
    details: { requestToken },
  });
}

/**
 * 「勾了人但一个都没勾」的防御式断言（no-show 预检与执行共用）。
 *
 * `passengerIds` 的语义是**缺省才等于整单**：不传 = 没有按人选择 = 整单全员。
 * 传 `[]` 是另一回事 —— 前端勾选框全部取消时会发出这个形状，把它当成整单
 * 就会给全单的人打 no-show 标、把全单的回程座位放回库存，而请求体看上去毫无异常。
 */
export function assertNonEmptyPassengerSelection(passengerIds: readonly string[] | undefined): void {
  if (passengerIds != null && passengerIds.length === 0) {
    throw new BadRequestError('至少选择 1 位乘客；如需对整单操作请不要传乘客名单。');
  }
}

/** 防御式读 JSON 对象（形状不符按空对象处理）。 */
export function readJsonObject(raw: unknown): Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
