/**
 * 乘客级签证状态机 —— 签证的唯一事实源（审查根因 R3 的结构投资）。
 *
 * 背景：签证有五个真值源互相派生、没有单一状态机：
 *   ① Order.visaStatus（订单级录单档：不需要/需要/电子签/已签证）
 *   ② Passenger.visaExempt（自备签）
 *   ③ Passenger.visaSubmissionStatus（送签进度：待处理/材料准备/已送签）
 *   ④ FulfillmentTask VISA_APPLICATION（签证台读的任务 + 任务级状态）
 *   ⑤ 套餐签证组件 + selfVisaDeductCny（定价，本模块不碰钱）
 * 于是同一联动 5 天修 5 次、签证台漏 4 处、拆单不重派生 —— 每个写点各自手抄半条口径。
 *
 * 本模块做三件事，**不加任何 schema 列**（派生为主）：
 *   1. 派生：从 ①②③ 纯函数算出每位乘客的状态 `PassengerVisaState`，再由乘客状态派生
 *      订单级办结（deriveOrderVisaStatus）与任务级状态（deriveVisaTaskStatus）。
 *   2. 转移：`transitionPassengerVisa(facts, event)` 带守卫的转移表——每个写入路径先问它
 *      「能不能改、改完写哪几列」，守卫失败的文案也只在这里定义一份。
 *   3. 落库：Passenger.visaExempt / Passenger.visaSubmissionStatus / Order.visaStatus 各自
 *      **唯一**的写函数，以及任务级状态的唯一重派生函数。业务模块禁止再直写这几列。
 *
 * 状态（名字按现有枚举对齐，不另造语义；括号内是设计稿里的别名）：
 *   NOT_NEEDED     订单级「不需要签证」——录单联动全员自备签属于此态，跟订单头（0827/0903）
 *   SELF_ARRANGED  客人自备签（visaExempt=true），不进签证台、不计数、导出金额 0
 *   PENDING        我方代办·待处理（≈ AWAITING_DOCS）
 *   IN_PROGRESS    我方代办·材料准备（≈ DOCS_READY）
 *   SUBMITTED      我方代办·已送签（visaSubmissionStatus=CONFIRMED；「材料送出去就算」0830）
 *   ISSUED         已签证（订单级 HAS_VISA：录单手选的客人自持，或全员已送签自动办结）
 *
 * 派生优先级（与导出「签证状态」列逐字一致，0904 拍板）：
 *   1. 逐人推进的送签进度压过一切（材料准备/已送签）——「逐人事实压过订单头」
 *   2. 订单级 NOT_NEEDED → NOT_NEEDED（联动置上的自备签跟订单头，不写「自备签」）
 *   3. 订单级 HAS_VISA → 混合单里逐人手勾的自备签写 SELF_ARRANGED，其余 ISSUED
 *   4. visaExempt → SELF_ARRANGED
 *   5. 其余（NEEDED / E_VISA / 未表态）→ PENDING
 *
 * 任务的「有无」（该不该有一条活的 VISA_APPLICATION）仍由 orders/visa-need.ts 的
 * orderNeedsVisaTask 判定、orders.service 的 syncVisaTasksForOrder 执行 —— 那是订单级三根轴
 * 的收口，本模块不重复它；本模块只管任务的**状态**从乘客进度派生。
 */
import {
  FulfillmentStatus,
  FulfillmentType,
  Prisma,
  VisaRequirement,
  VisaSubmissionStatus,
} from '@prisma/client';
import { BadRequestError } from '../../lib/errors.js';
import { isVisaContradiction, VISA_CONTRADICTION_MESSAGE } from '../orders/visa-need.js';

// ═══════════════════════════════════════════════════════════════════════════
// 状态与事实
// ═══════════════════════════════════════════════════════════════════════════

export type PassengerVisaState =
  | 'NOT_NEEDED'
  | 'SELF_ARRANGED'
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'ISSUED';

export const PASSENGER_VISA_STATES: readonly PassengerVisaState[] = [
  'NOT_NEEDED',
  'SELF_ARRANGED',
  'PENDING',
  'IN_PROGRESS',
  'SUBMITTED',
  'ISSUED',
];

/** 各态的中文文案（签证台/订单页通用；导出列另有「回落订单头文案」的规则，见 export-templates）。 */
export const PASSENGER_VISA_STATE_LABEL: Record<PassengerVisaState, string> = {
  NOT_NEEDED: '不需要',
  SELF_ARRANGED: '自备签',
  PENDING: '待处理',
  IN_PROGRESS: '材料准备',
  SUBMITTED: '已送签',
  ISSUED: '已签证',
};

/** 派生一位乘客状态所需的全部事实（三根轴 + 一个订单级汇总）。老数据缺列一律按默认值。 */
export interface PassengerVisaFacts {
  orderVisaStatus: VisaRequirement | null | undefined;
  visaExempt: boolean | null | undefined;
  visaSubmissionStatus: VisaSubmissionStatus | null | undefined;
  /**
   * 单内是否**全员**自备签（订单级算一次传入）。只影响订单级 HAS_VISA 的单：
   * 全员置上 = 录单联动，跟订单头写 ISSUED；混合单里的自备签是逐人手勾的，写 SELF_ARRANGED。
   */
  allPassengersExempt: boolean;
}

export function derivePassengerVisaState(facts: PassengerVisaFacts): PassengerVisaState {
  const submission = facts.visaSubmissionStatus ?? VisaSubmissionStatus.PENDING;
  if (submission === VisaSubmissionStatus.IN_PROGRESS) return 'IN_PROGRESS';
  if (submission === VisaSubmissionStatus.CONFIRMED) return 'SUBMITTED';
  const exempt = facts.visaExempt === true;
  if (facts.orderVisaStatus === VisaRequirement.NOT_NEEDED) return 'NOT_NEEDED';
  if (facts.orderVisaStatus === VisaRequirement.HAS_VISA) {
    return exempt && !facts.allPassengersExempt ? 'SELF_ARRANGED' : 'ISSUED';
  }
  if (exempt) return 'SELF_ARRANGED';
  return 'PENDING';
}

/** 单内是否全员自备签（空名单 → false；缺省字段按随团办签）。 */
export function allPassengersVisaExempt(
  passengers: ReadonlyArray<{ visaExempt?: boolean | null }>,
): boolean {
  return passengers.length > 0 && passengers.every((p) => p.visaExempt === true);
}

/** 整单派生：一次算好 allPassengersExempt，给每位乘客贴上状态。 */
export function deriveOrderVisaStates<
  P extends { visaExempt?: boolean | null; visaSubmissionStatus?: VisaSubmissionStatus | null },
>(
  order: { visaStatus: VisaRequirement | null | undefined },
  passengers: ReadonlyArray<P>,
): Array<P & { state: PassengerVisaState }> {
  const allPassengersExempt = allPassengersVisaExempt(passengers);
  return passengers.map((p) => ({
    ...p,
    state: derivePassengerVisaState({
      orderVisaStatus: order.visaStatus,
      visaExempt: p.visaExempt,
      visaSubmissionStatus: p.visaSubmissionStatus,
      allPassengersExempt,
    }),
  }));
}

/**
 * 订单级办结派生（0830「材料送出去就算」）：
 *   非自备签乘客**全部** SUBMITTED、且至少一位、且确有我方签证任务 → HAS_VISA；
 *   否则回落 declared（录单/改单声明的档，办结前原档由调用方从审计取）。
 *
 * 「我方的人」按 visaExempt 列圈定而不是按 state（state=SUBMITTED 的自备签乘客是换人残留的
 * 矛盾行，不算我方送签数——与签证台统计条同口径）。
 */
export function deriveOrderVisaStatus(input: {
  declared: VisaRequirement | null;
  passengers: ReadonlyArray<{ visaExempt?: boolean | null; state: PassengerVisaState }>;
  hasOurVisaTask: boolean;
}): VisaRequirement | null {
  const ours = input.passengers.filter((p) => p.visaExempt !== true);
  const allSubmitted = ours.length > 0 && ours.every((p) => p.state === 'SUBMITTED');
  if (allSubmitted && input.hasOurVisaTask) return VisaRequirement.HAS_VISA;
  return input.declared;
}

// ═══════════════════════════════════════════════════════════════════════════
// 任务级状态派生（从 fulfillment.service 迁入；语义一字不改）
// ═══════════════════════════════════════════════════════════════════════════

/** 送签进度的推进次序（低→高）——派生任务级状态时取「最早（最低）」那一档。 */
const VISA_SUBMISSION_RANK: Record<VisaSubmissionStatus, number> = {
  [VisaSubmissionStatus.PENDING]: 0,
  [VisaSubmissionStatus.IN_PROGRESS]: 1,
  [VisaSubmissionStatus.CONFIRMED]: 2,
};

/** 乘客送签进度 → 任务级 FulfillmentStatus 的恒等映射（成员同名，语义一致）。 */
const SUBMISSION_TO_TASK: Record<VisaSubmissionStatus, FulfillmentStatus> = {
  [VisaSubmissionStatus.PENDING]: FulfillmentStatus.PENDING,
  [VisaSubmissionStatus.IN_PROGRESS]: FulfillmentStatus.IN_PROGRESS,
  [VisaSubmissionStatus.CONFIRMED]: FulfillmentStatus.CONFIRMED,
};

/**
 * 派生口径：全部需签乘客到达某档，任务才算该档；只要有人更早，任务保持较早那一档。
 *   实现 = 取所有非自备签乘客送签进度里**最低**的一档，再恒等映射到任务级状态。
 * 无非自备签乘客（空数组）→ PENDING（无人可送，保持待处理）。
 */
export function deriveVisaTaskStatus(statuses: ReadonlyArray<VisaSubmissionStatus>): FulfillmentStatus {
  if (statuses.length === 0) return FulfillmentStatus.PENDING;
  let lowest = statuses[0];
  for (const s of statuses) {
    if (VISA_SUBMISSION_RANK[s] < VISA_SUBMISSION_RANK[lowest]) lowest = s;
  }
  return SUBMISSION_TO_TASK[lowest];
}

/**
 * 任务级三档进度状态（可由乘客派生 / 被派生覆盖）——CANCELLED/FAILED 为终态，不在此列，
 * 派生只在这三档之间流转，永不复活终态。
 */
export const DERIVABLE_TASK_STATUSES: readonly FulfillmentStatus[] = [
  FulfillmentStatus.PENDING,
  FulfillmentStatus.IN_PROGRESS,
  FulfillmentStatus.CONFIRMED,
];

/** 任务级状态是否属于「可映射到乘客送签进度」的三档（成员名与 VisaSubmissionStatus 逐字相同）。 */
export function isVisaSubmissionStatus(s: FulfillmentStatus): boolean {
  return DERIVABLE_TASK_STATUSES.includes(s);
}

/** 把已确认属于三档进度的任务级状态转成乘客级 VisaSubmissionStatus（同名枚举值，运行时等值）。 */
export function asVisaSubmissionStatus(s: FulfillmentStatus): VisaSubmissionStatus {
  return s as unknown as VisaSubmissionStatus;
}

// ═══════════════════════════════════════════════════════════════════════════
// 事件与转移表
// ═══════════════════════════════════════════════════════════════════════════

export type PassengerVisaEvent =
  /** 录单/改单：订单级「不需要签证」（0827 联动的服务端形态：不碰乘客列，派生自然跟订单头） */
  | { type: 'DECLARE_NOT_NEEDED' }
  /** 录单/改单：订单级「需要签证 / 电子签」 */
  | { type: 'DECLARE_NEEDED'; visaStatus: 'NEEDED' | 'E_VISA' }
  /** 出签 / 客人自持：订单级「已签证」（签证岗盖章或系统办结；代理不得自设，路由层 403） */
  | { type: 'DECLARE_HAS_VISA' }
  /** 乘客改自备签。送签已在办理时须人为确认（submittedConfirmed=true），0830 二期 C */
  | { type: 'DECLARE_SELF_ARRANGED'; submittedConfirmed?: boolean }
  /** 乘客改回随团办签 */
  | { type: 'REVOKE_SELF_ARRANGED' }
  /** 上传护照：不改签证状态（缺件由 passportPhotoUrl 单独判定，提醒 VISA_MISSING） */
  | { type: 'UPLOAD_PASSPORT' }
  /** 材料齐（签证台「已送签材料准备」） */
  | { type: 'MARK_DOCS_READY' }
  /** 送签（签证台「已送签」） */
  | { type: 'SUBMIT' }
  /** 退回：签证台把进度往回标（材料准备 / 待处理） */
  | { type: 'REVERT'; to?: 'PENDING' | 'IN_PROGRESS' }
  /** 换人：证件号变化时自备签回落 false（不显式带值时）；送签进度**不**重置（现状，见矛盾清单） */
  | { type: 'SWAP_PASSENGER'; visaExempt?: boolean; documentChanged: boolean }
  /** 拆单搬迁：状态原样随人走（列不动） */
  | { type: 'SPLIT_MOVE' };

export type PassengerVisaTransition =
  | {
      ok: true;
      from: PassengerVisaState;
      to: PassengerVisaState;
      /** 事件应用后的事实（未落库；调用方据此决定写哪几列）。 */
      facts: PassengerVisaFacts;
      /** 是否有列真的变了（幂等事件 → false，调用方据此跳过写库/审计）。 */
      changed: boolean;
      write: {
        passenger?: Partial<{ visaExempt: boolean; visaSubmissionStatus: VisaSubmissionStatus }>;
        order?: { visaStatus: VisaRequirement };
      };
    }
  | {
      ok: false;
      from: PassengerVisaState;
      code: 'SELF_ARRANGED' | 'NEED_CONFIRM_SUBMITTED';
      reason: string;
    };

/** 守卫文案：自备签乘客不推送签进度（签证台按人标记 / 单个标记共用）。 */
export const VISA_SELF_ARRANGED_NO_PROGRESS_MESSAGE = '该乘客自备签证，无需送签';
/** 守卫文案：送签已在办理的乘客改自备签需人为确认退费（前端据 [NEED_CONFIRM_SUBMITTED] 标记弹框）。 */
export const VISA_NEED_CONFIRM_SUBMITTED_MESSAGE =
  '[NEED_CONFIRM_SUBMITTED] 该乘客送签已在办理（材料准备/已送签），批文成本已发生。' +
  '请确认退费金额（0 = 不退）与原因后重试。';

function progressWrite(
  facts: PassengerVisaFacts,
  from: PassengerVisaState,
  to: VisaSubmissionStatus,
): PassengerVisaTransition {
  // 守卫：自备签乘客不推进度（按 visaExempt 列判，不按派生态——换人残留的
  // 「自备签 + 有进度」矛盾行派生成 SUBMITTED，仍不该被签证台推进）。
  if (facts.visaExempt === true) {
    return { ok: false, from, code: 'SELF_ARRANGED', reason: VISA_SELF_ARRANGED_NO_PROGRESS_MESSAGE };
  }
  const next = { ...facts, visaSubmissionStatus: to };
  const changed = (facts.visaSubmissionStatus ?? VisaSubmissionStatus.PENDING) !== to;
  return {
    ok: true,
    from,
    to: derivePassengerVisaState(next),
    facts: next,
    changed,
    write: changed ? { passenger: { visaSubmissionStatus: to } } : {},
  };
}

function orderWrite(
  facts: PassengerVisaFacts,
  from: PassengerVisaState,
  visaStatus: VisaRequirement,
): PassengerVisaTransition {
  const next = { ...facts, orderVisaStatus: visaStatus };
  const changed = facts.orderVisaStatus !== visaStatus;
  return {
    ok: true,
    from,
    to: derivePassengerVisaState(next),
    facts: next,
    changed,
    write: changed ? { order: { visaStatus } } : {},
  };
}

/**
 * 带守卫的转移表。纯函数：只算「能不能 + 改完是什么样 + 该写哪几列」，不碰库。
 *
 * | 事件                    | 守卫                                        | 写入                                   |
 * |-------------------------|---------------------------------------------|----------------------------------------|
 * | DECLARE_NOT_NEEDED      | （订单级矛盾闸另行判，见 assertNoVisaContradiction）| Order.visaStatus=NOT_NEEDED           |
 * | DECLARE_NEEDED          | 同上                                        | Order.visaStatus=NEEDED/E_VISA         |
 * | DECLARE_HAS_VISA        | 同上（代理 403 在路由层）                    | Order.visaStatus=HAS_VISA              |
 * | DECLARE_SELF_ARRANGED   | 进度≠PENDING 时须 submittedConfirmed         | visaExempt=true, 进度=PENDING          |
 * | REVOKE_SELF_ARRANGED    | —                                           | visaExempt=false, 进度=PENDING         |
 * | UPLOAD_PASSPORT         | —                                           | 无（不改签证状态）                     |
 * | MARK_DOCS_READY         | 非自备签                                    | 进度=IN_PROGRESS                       |
 * | SUBMIT                  | 非自备签                                    | 进度=CONFIRMED                         |
 * | REVERT                  | 非自备签                                    | 进度=PENDING / IN_PROGRESS             |
 * | SWAP_PASSENGER          | —                                           | 证件变化且未带值 → visaExempt=false     |
 * | SPLIT_MOVE              | —                                           | 无（状态随人走）                       |
 */
export function transitionPassengerVisa(
  facts: PassengerVisaFacts,
  event: PassengerVisaEvent,
): PassengerVisaTransition {
  const from = derivePassengerVisaState(facts);
  switch (event.type) {
    case 'DECLARE_NOT_NEEDED':
      return orderWrite(facts, from, VisaRequirement.NOT_NEEDED);
    case 'DECLARE_NEEDED':
      return orderWrite(facts, from, VisaRequirement[event.visaStatus]);
    case 'DECLARE_HAS_VISA':
      return orderWrite(facts, from, VisaRequirement.HAS_VISA);
    case 'DECLARE_SELF_ARRANGED': {
      if (facts.visaExempt === true) {
        return { ok: true, from, to: from, facts, changed: false, write: {} };
      }
      const inProcess =
        (facts.visaSubmissionStatus ?? VisaSubmissionStatus.PENDING) !== VisaSubmissionStatus.PENDING;
      if (inProcess && !event.submittedConfirmed) {
        return {
          ok: false,
          from,
          code: 'NEED_CONFIRM_SUBMITTED',
          reason: VISA_NEED_CONFIRM_SUBMITTED_MESSAGE,
        };
      }
      const next = { ...facts, visaExempt: true, visaSubmissionStatus: VisaSubmissionStatus.PENDING };
      return {
        ok: true,
        from,
        to: derivePassengerVisaState(next),
        facts: next,
        changed: true,
        write: { passenger: { visaExempt: true, visaSubmissionStatus: VisaSubmissionStatus.PENDING } },
      };
    }
    case 'REVOKE_SELF_ARRANGED': {
      if (facts.visaExempt !== true) {
        return { ok: true, from, to: from, facts, changed: false, write: {} };
      }
      // true→false 连已确认的进度也置回 PENDING：人已换办签方式，旧进度复活会污染任务派生
      const next = { ...facts, visaExempt: false, visaSubmissionStatus: VisaSubmissionStatus.PENDING };
      return {
        ok: true,
        from,
        to: derivePassengerVisaState(next),
        facts: next,
        changed: true,
        write: { passenger: { visaExempt: false, visaSubmissionStatus: VisaSubmissionStatus.PENDING } },
      };
    }
    case 'UPLOAD_PASSPORT':
    case 'SPLIT_MOVE':
      return { ok: true, from, to: from, facts, changed: false, write: {} };
    case 'MARK_DOCS_READY':
      return progressWrite(facts, from, VisaSubmissionStatus.IN_PROGRESS);
    case 'SUBMIT':
      return progressWrite(facts, from, VisaSubmissionStatus.CONFIRMED);
    case 'REVERT':
      return progressWrite(
        facts,
        from,
        event.to === 'IN_PROGRESS' ? VisaSubmissionStatus.IN_PROGRESS : VisaSubmissionStatus.PENDING,
      );
    case 'SWAP_PASSENGER': {
      // 显式带值 > 证件变化回落 false（旧人自备签的 true 绝不继承）> 保持原值。进度不动（现状）。
      // 「事件给出了明确值」（显式带值 / 真换人回落）就进 write——换人是一条 UPDATE 同时写身份列与
      // 自备签列，即便新值与旧值相同也照写（幂等），与换人通道既有的落库形状一致；
      // changed 仍只表示值是否真的变了（调用方据此决定要不要跑任务同步）。
      const resolved = event.visaExempt !== undefined || event.documentChanged;
      const visaExempt =
        event.visaExempt !== undefined
          ? event.visaExempt
          : event.documentChanged
            ? false
            : facts.visaExempt === true;
      const changed = visaExempt !== (facts.visaExempt === true);
      const next = { ...facts, visaExempt };
      return {
        ok: true,
        from,
        to: derivePassengerVisaState(next),
        facts: next,
        changed,
        write: resolved ? { passenger: { visaExempt } } : {},
      };
    }
  }
}

/**
 * 订单级录单档 → 声明事件（录单 / 改备注 / 改单申请 / 代理自助改签证状态共用的翻译）。
 */
export function orderVisaDeclarationEvent(visaStatus: VisaRequirement): PassengerVisaEvent {
  switch (visaStatus) {
    case VisaRequirement.NOT_NEEDED:
      return { type: 'DECLARE_NOT_NEEDED' };
    case VisaRequirement.HAS_VISA:
      return { type: 'DECLARE_HAS_VISA' };
    case VisaRequirement.E_VISA:
      return { type: 'DECLARE_NEEDED', visaStatus: 'E_VISA' };
    case VisaRequirement.NEEDED:
      return { type: 'DECLARE_NEEDED', visaStatus: 'NEEDED' };
  }
}

/**
 * 签证台「按人标进度」的目标档 → 事件。签证台允许任意方向（PENDING→CONFIRMED 直达、
 * CONFIRMED→IN_PROGRESS 退回），这里只做语义翻译，守卫仍在 transitionPassengerVisa。
 */
export function visaProgressEvent(
  to: VisaSubmissionStatus,
  current: VisaSubmissionStatus | null | undefined,
): PassengerVisaEvent {
  const cur = current ?? VisaSubmissionStatus.PENDING;
  if (to === VisaSubmissionStatus.CONFIRMED) return { type: 'SUBMIT' };
  if (to === VisaSubmissionStatus.IN_PROGRESS) {
    return cur === VisaSubmissionStatus.CONFIRMED
      ? { type: 'REVERT', to: 'IN_PROGRESS' }
      : { type: 'MARK_DOCS_READY' };
  }
  return { type: 'REVERT', to: 'PENDING' };
}

/**
 * 订单级矛盾闸（0901 硬拦）：订单级「需要签证 / 电子签」+ 已录出行人全部自备签 → 400。
 * 建单 / 换人 / 改自备签 / 改订单签证状态四条写入路径共用这一处，文案一份。
 */
export function assertNoVisaContradiction(input: {
  visaStatus: VisaRequirement | null | undefined;
  passengers: ReadonlyArray<{ visaExempt?: boolean | null }>;
}): void {
  if (isVisaContradiction(input)) throw new BadRequestError(VISA_CONTRADICTION_MESSAGE);
}

// ═══════════════════════════════════════════════════════════════════════════
// 落库：三列各一个唯一写点 + 任务状态唯一重派生点
// ═══════════════════════════════════════════════════════════════════════════

/** 写签证列只用得到这三个委托；tx 与全局 prisma 都满足。 */
export type VisaDb = Pick<Prisma.TransactionClient, 'passenger' | 'fulfillmentTask' | 'order'>;

/** 「我方要送签的人」= 非自备签乘客——签证台列表/统计/护照包/提醒共用的圈定条件。 */
export function ourVisaPassengersWhere(orderId?: string): Prisma.PassengerWhereInput {
  return orderId ? { orderId, visaExempt: false } : { visaExempt: false };
}

/** 「我方要送签且还没送出去的人」——提醒 VISA_NOT_SUBMITTED 的圈定条件。 */
export function ourUnsubmittedVisaPassengersWhere(): Prisma.PassengerWhereInput {
  return { visaExempt: false, visaSubmissionStatus: { not: VisaSubmissionStatus.CONFIRMED } };
}

/**
 * Passenger.visaSubmissionStatus 的唯一写点。
 *   · { passengerIds } —— 按人（签证台按人/批量标记；调用方已用 transitionPassengerVisa 逐人过守卫）
 *   · { orderId }      —— 整单非自备签乘客（任务级流转「作用于整单」的旧语义）
 */
export async function writePassengerVisaProgress(
  db: VisaDb,
  target: { passengerIds: string[] } | { orderId: string },
  to: VisaSubmissionStatus,
): Promise<number> {
  const where: Prisma.PassengerWhereInput =
    'passengerIds' in target ? { id: { in: target.passengerIds } } : ourVisaPassengersWhere(target.orderId);
  const res = await db.passenger.updateMany({ where, data: { visaSubmissionStatus: to } });
  return res.count;
}

/**
 * Passenger.visaExempt 的唯一写点（建单后）；进度列随事件一起写（转移表决定）。
 * `extra` 是要与签证列同一条 UPDATE 落库的其它列（换人通道的身份/护照列）——换人在界面上是
 * 一次提交，落库也必须是一次；签证列后写、压过 extra 里的同名键。
 */
export async function writePassengerVisaExempt(
  db: VisaDb,
  passengerId: string,
  data: { visaExempt: boolean; visaSubmissionStatus?: VisaSubmissionStatus },
  extra?: Prisma.PassengerUpdateInput,
): Promise<void> {
  await db.passenger.update({ where: { id: passengerId }, data: { ...(extra ?? {}), ...data } });
}

/**
 * Order.visaStatus 的唯一写点（建单后）。`extra` 是要与签证状态同一条 UPDATE 落库的其它列
 * （notes 路由的备注四栏）——界面上是一次提交，落库也必须是一次。
 */
export async function writeOrderVisaStatus(
  db: VisaDb,
  orderId: string,
  visaStatus: VisaRequirement,
  extra?: Prisma.OrderUpdateInput,
): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: { ...(extra ?? {}), visaStatus } });
}

/**
 * 任务级状态的唯一重派生点：VISA_APPLICATION 任务状态 := 非自备签乘客进度的最低档。
 *
 * `touch` = 允许被改写的任务状态集合（调用方按自己的口径给）：
 *   · 签证台按人标记 → DERIVABLE_TASK_STATUSES（含 CONFIRMED：退回一人任务就退回）
 *   · 改自备签 → [PENDING, IN_PROGRESS]（CONFIRMED 不被系统悄悄改写，留给签证岗）
 * CANCELLED / FAILED 永不在集合里：终态不复活。
 * `statuses` 可传调用方已查好的非自备签进度（省一次回表）；缺省按 orderId 查。
 * completedAt：派生为 CONFIRMED 时盖当前时间，否则清空（与任务级 update 的完成时间语义一致）。
 */
export async function rederiveVisaTaskStatus(
  db: VisaDb,
  orderId: string,
  opts: { touch: ReadonlyArray<FulfillmentStatus>; statuses?: ReadonlyArray<VisaSubmissionStatus> },
): Promise<FulfillmentStatus> {
  const statuses = (
    opts.statuses ??
    (
      await db.passenger.findMany({
        where: ourVisaPassengersWhere(orderId),
        select: { visaSubmissionStatus: true },
      })
    ).map((p) => p.visaSubmissionStatus)
  ).map((s) => s ?? VisaSubmissionStatus.PENDING); // 老数据缺列一律按待处理
  const derived = deriveVisaTaskStatus(statuses);
  await db.fulfillmentTask.updateMany({
    where: {
      orderItem: { orderId },
      type: FulfillmentType.VISA_APPLICATION,
      status: { in: [...opts.touch] },
    },
    data: {
      status: derived,
      completedAt: derived === FulfillmentStatus.CONFIRMED ? new Date() : null,
    },
  });
  return derived;
}

/**
 * 换人 resetVisa：该单 VISA 任务回「待处理」（新出行人重新送签）—— 任务级重置的唯一写点。
 *
 * 只重置活动态（IN_PROGRESS / CONFIRMED / FAILED）→ PENDING，绝不碰 CANCELLED：
 * CANCELLED 是取消族订单终态化任务留下的终态记录，把它一并 PENDING 化会「复活」已取消订单的
 * 履约任务（看板凭空冒出可执行任务、统计口径错乱）。CANCELLED 永远冻结为终态。
 *
 * 注意（现状，见收口方案「状态机」一节的矛盾清单）：这里只重置**任务**，乘客级送签进度不动——
 * 换人事件 SWAP_PASSENGER 本身也不重置进度。返回被重置的任务数。
 */
export async function resetVisaTaskProgress(db: VisaDb, orderId: string): Promise<number> {
  const reset = await db.fulfillmentTask.updateMany({
    where: {
      type: FulfillmentType.VISA_APPLICATION,
      orderItem: { orderId },
      status: { notIn: [FulfillmentStatus.PENDING, FulfillmentStatus.CANCELLED] },
    },
    data: {
      status: FulfillmentStatus.PENDING,
      startedAt: null,
      completedAt: null,
      failureReason: null,
    },
  });
  return reset.count;
}
